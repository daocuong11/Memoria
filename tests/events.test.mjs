/* Q2a: structured session events → memories. Claude Code (update_plan,
 * AskUserQuestion with toolUseResult, ai-title/custom-title) and OpenCode
 * (todowrite, question, the todo table, session title) fixtures follow the
 * on-disk formats seen in real data. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-events-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
const { scanClaude } = require("../dist/engine/ingest/claude.js");
const { scanOpencode } = require("../dist/engine/ingest/opencode.js");
const { materializeEvents, questionDecision } = require("../dist/engine/extract/events.js");
const { normalizeTodos } = require("../dist/engine/ingest/events.js");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const iso = (s) => new Date(Date.UTC(2026, 10, 20, 10, 0, s)).toISOString();
const jsonl = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const embed = async () => null;
const mem = (sql, ...p) => dbmod.getDb().prepare(sql).all(...p);

test("normalizeTodos: status aliases, empty and duplicate items dropped", () => {
  assert.deepEqual(
    normalizeTodos([
      { content: "  Write   parser ", status: "in-progress" },
      { content: "write parser", status: "done" },
      { content: "", status: "pending" },
      { text: "Ship it", status: "done" },
      { content: "Odd status", status: "weird" },
    ]),
    [
      { content: "Write parser", status: "in_progress" },
      { content: "Ship it", status: "completed" },
      { content: "Odd status", status: "pending" },
    ]
  );
});

test("questionDecision: choice → durable, approval → working, asked back / unanswered → none", () => {
  const q = (answer, options = ["Landing page saja", "Full app"]) => questionDecision({ question: "Scope V1 yang mana?", header: "Scope", options, answer });
  assert.deepEqual(q("Landing page saja"), { content: "Scope V1 yang mana? → Landing page saja", memoryClass: "durable" });
  assert.equal(q("Pakai Next.js App Router dengan Tailwind").memoryClass, "durable", "a short free-text choice is a decision");
  assert.equal(q("ok").memoryClass, "working");
  assert.equal(q("Ya, jalanin sekarang").memoryClass, "working");
  assert.equal(q("bedanya apa dengan yang sekarang ? maksud saya agak lupa projek ini sampai tahap mana sih sebenarnya kemarin itu").memoryClass, "working");
  assert.equal(q("bedanya apa sama yang lama?"), null);
  assert.equal(q("[User did not answer this question — they sent a message instead.]"), null);
  assert.equal(q(""), null);
});

test("claude: update_plan todos, AskUserQuestion and titles → events → memories", async () => {
  const root = tmp("mem-ev-claude-");
  const cwd = "/tmp/ev-claude";
  const plan = (id, s, items) => ({ type: "assistant", sessionId: "c1", cwd, gitBranch: "feat/plan", timestamp: iso(s), message: { content: [{ type: "tool_use", id, name: "mcp__ccd_turn__update_plan", input: { items } }] } });
  jsonl(path.join(root, "p", "c1.jsonl"), [
    { type: "ai-title", aiTitle: "Rate limiter for login", sessionId: "c1" },
    { type: "user", sessionId: "c1", cwd, timestamp: iso(1), message: { content: "Tambahkan rate limit di login" } },
    plan("t1", 2, [{ content: "Add rate limiter middleware", status: "in_progress" }, { content: "Write tests", status: "pending" }, { content: "Old idea", status: "pending" }]),
    { type: "assistant", sessionId: "c1", cwd, timestamp: iso(3), message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [] } }] } },
    {
      type: "user", sessionId: "c1", cwd, timestamp: iso(4),
      message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "Your questions have been answered: ..." }] },
      toolUseResult: {
        questions: [
          { question: "Limit per IP atau per akun?", header: "Scope", options: [{ label: "Per IP (Recommended)" }, { label: "Per akun" }] },
          { question: "Lanjut deploy ke staging sekarang?", header: "Deploy", options: [{ label: "Ya" }, { label: "Nanti" }] },
        ],
        answers: { "Limit per IP atau per akun?": "Per IP (Recommended)", "Lanjut deploy ke staging sekarang?": "ok" },
      },
    },
    plan("t2", 5, [{ content: "Add rate limiter middleware", status: "completed" }, { content: "Write tests", status: "in_progress" }, { content: "Old idea", status: "cancelled" }]),
    { type: "custom-title", customTitle: "Login rate limit", sessionId: "c1" },
  ]);
  await scanClaude(root);
  const events = dbmod.sessionEvents({ tool: "claude", sessionId: "c1" });
  assert.deepEqual(events.map((e) => e.type).sort(), ["question", "title", "title", "todo_list", "todo_list"]);
  assert.ok(events.every((e) => e.projectId), "title events get the session's project");
  assert.equal(events.find((e) => e.type === "todo_list").gitBranch, "feat/plan");
  assert.equal(mem("SELECT COUNT(*) AS c FROM transcripts WHERE tool = 'claude' AND session_id = 'c1' AND content LIKE '- [%'")[0].c, 0, "no checklist text rows");

  // The first list alone, as if the session had stopped there.
  const r1 = await materializeEvents(embed, { limit: 1 });
  assert.equal(r1.events, 1);
  await materializeEvents(embed);
  const tasks = mem("SELECT content, kind, memory_class, git_branch, source_session, archived, resolved_at FROM memories WHERE kind LIKE 'task%' ORDER BY content");
  assert.deepEqual(tasks.map((t) => [t.content, t.kind, t.archived]), [
    ["Add rate limiter middleware", "task_done", 0],
    ["Old idea", "task_pending", 1],
    ["Write tests", "task_pending", 0],
  ]);
  assert.ok(tasks[0].resolved_at > 0, "a completed todo is resolved");
  assert.equal(tasks[0].memory_class, "working");
  assert.equal(tasks[0].git_branch, "feat/plan");
  assert.equal(tasks[0].source_session, "c1");

  const decisions = mem("SELECT content, memory_class FROM memories WHERE kind = 'decision' ORDER BY content").map((r) => ({ ...r }));
  assert.deepEqual(decisions, [
    { content: "Lanjut deploy ke staging sekarang? → ok", memory_class: "working" },
    { content: "Limit per IP atau per akun? → Per IP", memory_class: "durable" },
  ]);

  // Idempotent: a re-scan and a second pass create nothing new.
  dbmod.getDb().prepare("UPDATE sources SET offset = 0 WHERE tool = 'claude'").run();
  await scanClaude(root);
  const again = await materializeEvents(embed);
  assert.equal(again.created, 0);
  assert.equal(mem("SELECT COUNT(*) AS c FROM session_events WHERE session_id = 'c1'")[0].c, 5);
});

test("a todo archived by the user stays archived when the agent updates it", async () => {
  const pid = dbmod.ensureProject("ev-arch", "/tmp/ev-arch");
  const ins = (ref, ts, status) =>
    dbmod.insertSessionEvent({ tool: "opencode", sessionId: "a1", projectId: pid, ts, type: "todo_list", sourceRef: ref, payload: { items: [{ content: "Refactor the queue", status }] } });
  ins("r1", 1, "pending");
  await materializeEvents(embed);
  const id = mem("SELECT id FROM memories WHERE content = 'Refactor the queue'")[0].id;
  dbmod.archiveMemory(id, true);
  ins("r2", 2, "completed");
  await materializeEvents(embed);
  const rows = mem("SELECT kind, archived FROM memories WHERE content = 'Refactor the queue'");
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: "task_pending", archived: 1 }]);
});

test("opencode: todowrite, question, todo table and session title", async () => {
  const dir = tmp("mem-ev-opencode-");
  const file = path.join(dir, "opencode.db");
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER);
          CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
          CREATE TABLE part (id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
          CREATE TABLE todo (session_id TEXT, content TEXT, status TEXT, priority TEXT, position INTEGER, time_created INTEGER, time_updated INTEGER);`);
  const t = Date.UTC(2026, 10, 20, 9, 0, 0);
  d.prepare("INSERT INTO session VALUES ('o1', '/tmp/ev-opencode', 'Mock mode for chat', ?)").run(t);
  d.prepare("INSERT INTO message VALUES ('m1', 'o1', ?, ?)").run(t + 1, JSON.stringify({ role: "assistant" }));
  const part = (id, i, data) => d.prepare("INSERT INTO part VALUES (?, 'm1', ?, ?)").run(id, t + i, JSON.stringify(data));
  part("p1", 1, { type: "tool", tool: "todowrite", callID: "call_a", state: { status: "completed", input: { todos: [{ content: "Buat mockData.js", status: "in_progress" }] } } });
  part("p2", 2, {
    type: "tool", tool: "question", callID: "call_q",
    state: {
      status: "completed",
      input: { questions: [{ question: "Strategi migrasi apa?", header: "Migrasi", options: [{ label: "Adapter ganda" }, { label: "Rewrite ke episode" }] }] },
      metadata: { answers: [["Rewrite ke episode"]] },
    },
  });
  d.prepare("INSERT INTO todo VALUES ('o1', 'Buat mockData.js', 'completed', 'high', 0, ?, ?)").run(t, t + 10);
  d.prepare("INSERT INTO todo VALUES ('o1', 'Routing live/mock', 'pending', 'high', 1, ?, ?)").run(t, t + 10);
  d.close();
  scanOpencode(file);
  const types = dbmod.sessionEvents({ tool: "opencode", sessionId: "o1" }).map((e) => e.type).sort();
  assert.deepEqual(types, ["question", "title", "todo_list", "todo_list"]);
  await materializeEvents(embed);
  const pid = dbmod.resolveProject("/tmp/ev-opencode").id;
  const rows = mem("SELECT kind, content FROM memories WHERE project_id = ? ORDER BY content", pid);
  assert.deepEqual(rows.map((r) => [r.kind, r.content]), [
    ["task_done", "Buat mockData.js"],
    ["task_pending", "Routing live/mock"],
    ["decision", "Strategi migrasi apa? → Rewrite ke episode"],
  ].sort((a, b) => a[1].localeCompare(b[1])));

  // The todo table changes without a new message: a re-scan picks it up.
  const d2 = new DatabaseSync(file);
  d2.prepare("UPDATE todo SET status = 'completed', time_updated = ? WHERE position = 1").run(t + 20);
  d2.close();
  scanOpencode(file);
  await materializeEvents(embed);
  assert.equal(mem("SELECT kind FROM memories WHERE content = 'Routing live/mock'")[0].kind, "task_done");
});
