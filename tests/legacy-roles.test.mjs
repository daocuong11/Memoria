/* M11: role repair for Claude Code rows stored by the pre-v0.12 parser, and
 * the snapshot taken before any pending migration. Own file so the db.ts
 * singleton in other suites is not replaced. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);

const { classifyLegacyClaudeRole } = require("../dist/engine/ingest/legacy-roles.js");
const dbmod = require("../dist/engine/store/db.js");

test("classifyLegacyClaudeRole: tool output, injected context, human text", () => {
  const tool = [
    "The file /Users/me/app/src/page.tsx has been updated successfully.",
    "File created successfully at: /Users/me/app/lib/x.ts",
    "(Bash completed with no output)",
    "    12\tconst x = 1;\n    13\treturn x;",
    "src/app/page.tsx:41: export default function Page() {",
    "a1b2c3d fix(api): retry on 429",
    "components/A.tsx components/B.tsx lib/c.ts",
    "/Users/me/Documents/Personal Project/app/README.md",
    "Compiling 1 files with Solc 0.8.26\n{\"abi\": [], \"bytecode\": \"0x6080\"}\nSuite result: ok. 2 passed;\nfinished in 10ms\nDone",
    "x".repeat(200).replace(/x/g, ".xOx"), // pathological input must stay fast
  ];
  for (const t of tool) assert.equal(classifyLegacyClaudeRole(t), "tool", t.slice(0, 60));

  const system = [
    "[Request interrupted by user]",
    "[Image: source: /private/tmp/claude-501/abc/images/1.png]",
    "<local-command-stdout>Set model to `opus`</local-command-stdout>",
    "This session is being continued from a previous conversation that ran out of context.",
  ];
  for (const t of system) assert.equal(classifyLegacyClaudeRole(t), "system", t.slice(0, 60));

  const user = [
    "cek dulu aja",
    "trus urutan yang bener yang mana sekarang aku mau test",
    "/Users/me/app/brief.md update kan disini aja ya",
    "[Image: source: /private/tmp/x/1.png] ini kenapa layoutnya pecah",
    "<pasted_content id=\"a1\">npm error code ENOENT</pasted_content>",
  ];
  for (const t of user) assert.equal(classifyLegacyClaudeRole(t), "user", t.slice(0, 60));
});

test("M11 touches only old-parser Claude sessions and snapshots first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-m11-"));
  dbmod.initDb(dir); // fresh DB at the latest version
  dbmod.closeDb();

  // Roll back to v10 and plant rows the way the old parser stored them.
  const raw = new DatabaseSync(path.join(dir, "memory.db"));
  const ins = raw.prepare("INSERT INTO transcripts (tool, session_id, project_id, role, content, ts, seq) VALUES (?, ?, 1, ?, ?, ?, ?)");
  let seq = 0;
  const now = Date.now();
  ins.run("claude", "old", "user", "tolong rapikan header landing", now, seq++);
  ins.run("claude", "old", "assistant", "Done.", now + 1, seq++);
  ins.run("claude", "old", "user", "The file /x/a.ts has been updated successfully.", now + 2, seq++);
  ins.run("claude", "old", "user", "[Request interrupted by user]", now + 3, seq++);
  // Written by the current parser: it already has a tool row, so it is left alone.
  ins.run("claude", "new", "tool", "(Bash completed with no output)", now + 4, seq++);
  ins.run("claude", "new", "user", "src/a.ts src/b.ts", now + 5, seq++);
  // Other tools are never touched.
  ins.run("opencode", "oc", "user", "The file /x/b.ts has been updated successfully.", now + 6, seq++);
  raw.exec("PRAGMA user_version = 10");
  raw.close();

  const d = dbmod.initDb(dir);
  assert.equal(Number(d.prepare("PRAGMA user_version").get().user_version), 11);
  const roles = Object.fromEntries(d.prepare("SELECT session_id || ':' || seq AS k, role FROM transcripts").all().map((r) => [r.k, r.role]));
  assert.equal(roles["old:0"], "user");
  assert.equal(roles["old:2"], "tool");
  assert.equal(roles["old:3"], "system");
  assert.equal(roles["new:5"], "user", "sessions from the current parser keep their roles");
  assert.equal(roles["oc:6"], "user", "only Claude rows are repaired");

  const snaps = fs.readdirSync(path.join(dir, "backups")).filter((f) => f.startsWith("memory-pre-v10-"));
  assert.equal(snaps.length, 1, "a snapshot is written before the migration");
  const snap = new DatabaseSync(path.join(dir, "backups", snaps[0]), { readOnly: true });
  assert.equal(Number(snap.prepare("PRAGMA user_version").get().user_version), 10);
  assert.equal(snap.prepare("SELECT role FROM transcripts WHERE session_id = 'old' AND seq = 2").get().role, "user");
  snap.close();

  // No pending migration → no new snapshot.
  dbmod.initDb(dir);
  assert.equal(fs.readdirSync(path.join(dir, "backups")).filter((f) => f.startsWith("memory-pre-")).length, 1);
  dbmod.closeDb();
});
