/* Step 14: `maintain backfill-events` re-reads Claude Code sessions that
 * were stored before session events existed, is idempotent, archives old
 * heuristic duplicates of a todo as one undoable batch, writes a backup, and
 * never writes resume blocks into project folders. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-bf-home-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-bf-data-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.MEMORIA_DATA_DIR = dataDir;
after(() => setTimeout(() => process.exit(0), 10));

const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(dataDir);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const { backfillEvents } = require("../dist/engine/ingest/backfill.js");
const { undoTriage } = require("../dist/engine/extract/triage.js");

const project = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-bf-proj-"));
const iso = (s) => new Date(Date.UTC(2026, 10, 2, 9, 0, s)).toISOString();
const file = path.join(home, ".claude", "projects", "p", "s1.jsonl");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(
  file,
  [
    { type: "user", sessionId: "s1", cwd: project, timestamp: iso(1), message: { content: "You've hit your limit · resets 5pm" } },
    { type: "assistant", sessionId: "s1", cwd: project, timestamp: iso(2), message: { content: [{ type: "tool_use", id: "t1", name: "TodoWrite", input: { todos: [{ content: "Write the migration", status: "completed" }] } }] } },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n"
);

test("backfill: old session gains events and memories; duplicates archived as one batch; idempotent; no project files", async () => {
  // Simulate a library read before v0.17: transcripts stored, offset at the
  // end of the file, a heuristic memory from the old checklist row.
  const { scanClaude } = require("../dist/engine/ingest/claude.js");
  await scanClaude(file);
  dbmod.getDb().exec("DELETE FROM session_events");
  const pid = dbmod.resolveProject(project).id;
  const oldId = dbmod.insertMemory({ projectId: pid, kind: "task_done", content: "- [x] Write the migration", importance: 0.5, createdAt: Date.now(), sourceTool: "claude", status: "draft", origin: "heuristic" });

  const r = await backfillEvents();
  assert.ok(r.backup && fs.existsSync(r.backup), "a backup is written first");
  assert.equal(r.events["claude/todo_list"], 1);
  assert.equal(r.newTranscripts, 0, "stored transcripts are not duplicated");
  assert.equal(r.duplicatesArchived, 1);
  const fresh = dbmod.getDb().prepare("SELECT kind, archived FROM memories WHERE content = 'Write the migration'").get();
  assert.deepEqual({ ...fresh }, { kind: "task_done", archived: 0 });
  assert.equal(dbmod.getDb().prepare("SELECT archived FROM memories WHERE id = ?").get(oldId).archived, 1);

  const again = await backfillEvents();
  assert.equal(again.memoriesCreated, 0);
  assert.equal(again.duplicatesArchived, 0);
  assert.equal(again.newTranscripts, 0);

  for (const f of ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]) assert.equal(fs.existsSync(path.join(project, f)), false, `${f} must not be written`);

  const u = undoTriage(r.batch);
  assert.equal(u.restored, 1);
  assert.equal(dbmod.getDb().prepare("SELECT archived FROM memories WHERE id = ?").get(oldId).archived, 0, "the batch can be undone");
});
