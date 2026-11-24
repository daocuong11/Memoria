/* Fixture tests for every transcript parser: roles (tool output is never
 * stored as user/assistant speech), injected tags stripped, agent todo lists
 * stored as session events, unique seq per message, and re-scans do not duplicate.
 * Fixtures are synthetic but follow each tool's on-disk format. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-ingest-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
const { scanClaude } = require("../dist/engine/ingest/claude.js");
const { scanCodex } = require("../dist/engine/ingest/codex.js");
const { scanOpencode } = require("../dist/engine/ingest/opencode.js");
const { scanCopilot } = require("../dist/engine/ingest/copilot.js");
const { scanGenericJsonl } = require("../dist/engine/ingest/generic.js");
const { scanVscdb } = require("../dist/engine/ingest/vscdb.js");
const { scanAntigravityBrain, cleanUserInput } = require("../dist/engine/ingest/antigravity-brain.js");
const { todosToChecklist } = require("../dist/engine/ingest/util.js");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rows = (tool, session) =>
  dbmod.getDb().prepare("SELECT role, content, seq FROM transcripts WHERE tool = ? AND session_id = ? ORDER BY seq").all(tool, session);
const jsonl = (file, lines) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
};
const iso = (s) => new Date(Date.UTC(2026, 10, 18, 10, 0, s)).toISOString();
function assertUniqueSeq(r) {
  assert.equal(new Set(r.map((x) => x.seq)).size, r.length, "every message gets its own seq");
}

test("todosToChecklist: completed → [x], others → [ ], cancelled dropped", () => {
  assert.equal(
    todosToChecklist([
      { content: "Write parser tests", status: "completed" },
      { content: "Ship  v0.14", status: "in_progress" },
      { content: "Old idea", status: "cancelled" },
    ]),
    "- [x] Write parser tests\n- [ ] Ship v0.14"
  );
});

test("claude: TodoWrite becomes a todo_list event (not a text row), tool_use-only message is not speech", async () => {
  const root = tmp("mem-claude-");
  const cwd = "/tmp/ingest-claude";
  jsonl(path.join(root, "p", "s.jsonl"), [
    { type: "user", sessionId: "c1", cwd, timestamp: iso(1), message: { content: "Tambahkan rate limit di login" } },
    { type: "assistant", sessionId: "c1", cwd, timestamp: iso(2), message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Add rate limiter middleware", status: "in_progress" }, { content: "Write tests", status: "pending" }] }, id: "tu1" }] } },
    { type: "user", sessionId: "c1", cwd, timestamp: iso(3), message: { content: [{ type: "tool_result", tool_use_id: "t", content: "Todos have been modified successfully" }] } },
    { type: "assistant", sessionId: "c1", cwd, timestamp: iso(4), message: { content: [{ type: "text", text: "Rate limiter ditambahkan." }] } },
  ]);
  await scanClaude(root);
  const r = rows("claude", "c1");
  assert.deepEqual(r.map((x) => x.role), ["user", "tool", "assistant"]);
  const ev = dbmod.sessionEvents({ tool: "claude", sessionId: "c1" });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "todo_list");
  assert.deepEqual(ev[0].payload.items, [{ content: "Add rate limiter middleware", status: "in_progress" }, { content: "Write tests", status: "pending" }]);
  assertUniqueSeq(r);
});

test("codex: injected context stripped, user + assistant roles, re-scan does not duplicate", async () => {
  const root = tmp("mem-codex-");
  const file = path.join(root, "2026", "11", "18", "rollout.jsonl");
  jsonl(file, [
    { type: "session_meta", timestamp: iso(0), payload: { cwd: "/tmp/ingest-codex" } },
    { type: "response_item", session_id: "x1", timestamp: iso(1), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd=/tmp</environment_context>\nFix the flaky test in api.spec.ts" }] } },
    { type: "response_item", session_id: "x1", timestamp: iso(2), payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The test was flaky because of a shared port; it now uses port 0." }] } },
  ]);
  await scanCodex(root);
  const r = rows("codex", "x1");
  assert.deepEqual(r.map((x) => x.role), ["user", "assistant"]);
  assert.equal(r[0].content, "Fix the flaky test in api.spec.ts");
  assertUniqueSeq(r);
  dbmod.getDb().prepare("UPDATE sources SET offset = 0 WHERE file = ?").run(file);
  await scanCodex(root);
  assert.equal(rows("codex", "x1").length, 2);
});

test("opencode: bash calls are tool rows, todowrite is an event, synthetic text skipped", () => {
  const dir = tmp("mem-opencode-");
  const file = path.join(dir, "opencode.db");
  const d = new DatabaseSync(file);
  d.exec(`CREATE TABLE session (id TEXT, directory TEXT, title TEXT, time_created INTEGER);
          CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
          CREATE TABLE part (id TEXT, message_id TEXT, time_created INTEGER, data TEXT);`);
  const t = Date.UTC(2026, 10, 18, 9, 0, 0);
  d.prepare("INSERT INTO session VALUES ('o1', '/tmp/ingest-opencode', 'x', ?)").run(t);
  d.prepare("INSERT INTO message VALUES ('m1', 'o1', ?, ?)").run(t + 1, JSON.stringify({ role: "user" }));
  d.prepare("INSERT INTO message VALUES ('m2', 'o1', ?, ?)").run(t + 2, JSON.stringify({ role: "assistant" }));
  const part = (id, msg, i, data) => d.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(id, msg, t + i, JSON.stringify(data));
  part("p1", "m1", 1, { type: "text", text: "Buat mock mode untuk chat" });
  part("p2", "m1", 2, { type: "text", text: "<system-reminder>internal</system-reminder>", synthetic: true });
  part("p3", "m2", 3, { type: "text", text: "Mock mode lewat flag isMockMode di store." });
  part("p4", "m2", 4, { type: "tool", tool: "bash", state: { input: { command: "npm test" }, output: "ok" } });
  part("p5", "m2", 5, { type: "tool", tool: "todowrite", state: { input: { todos: [{ content: "Buat mockData.js", status: "completed" }, { content: "Routing live/mock", status: "pending" }] } } });
  d.close();
  scanOpencode(file);
  const r = rows("opencode", "o1");
  assert.deepEqual(r.map((x) => x.role), ["user", "assistant", "tool"]);
  assert.equal(r[0].content, "Buat mock mode untuk chat", "synthetic part not stored");
  assert.ok(!r[1].content.includes("[command]"), "assistant text no longer carries commands");
  assert.equal(r[2].content, "$ npm test");
  const todo = dbmod.sessionEvents({ tool: "opencode", sessionId: "o1", types: ["todo_list"] });
  assert.equal(todo.length, 1);
  assert.deepEqual(todo[0].payload.items.map((i) => i.status), ["completed", "pending"]);
  assertUniqueSeq(r);
});

test("copilot: every message gets a unique seq (seq used to restart at 0 each scan)", () => {
  const file = path.join(tmp("mem-copilot-"), "session-store.db");
  const d = new DatabaseSync(file);
  d.exec("CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, created_at INTEGER)");
  const ins = d.prepare("INSERT INTO messages VALUES ('cp1', ?, ?, ?)");
  ins.run("user", "How do I paginate the list endpoint?", 1795000001);
  ins.run("assistant", "Use keyset pagination on created_at.", 1795000002);
  ins.run("tool", "{\"rows\": 50}", 1795000003);
  d.close();
  scanCopilot(file);
  const r = rows("copilot", "cp1");
  assert.deepEqual(r.map((x) => x.role), ["user", "assistant"], "tool rows are not stored as speech");
  assertUniqueSeq(r);
  scanCopilot(file);
  assert.equal(rows("copilot", "cp1").length, 2, "re-scan does not duplicate");
});

test("generic jsonl (Gemini CLI): tool/function rows tagged tool, brain folders skipped", async () => {
  const root = tmp("mem-gemini-");
  jsonl(path.join(root, "sessions", "g.jsonl"), [
    { sessionId: "g1", type: "user", timestamp: iso(1), content: "Explain the retry policy" },
    { sessionId: "g1", type: "gemini", role: "model", timestamp: iso(2), content: "Retries use exponential backoff capped at 30s." },
    { sessionId: "g1", type: "tool_call", timestamp: iso(3), content: "read_file src/retry.ts" },
  ]);
  jsonl(path.join(root, "antigravity", "brain", "b", "x.jsonl"), [{ sessionId: "g2", type: "user", content: "must be skipped here" }]);
  await scanGenericJsonl("gemini", [root], [".jsonl"]);
  assert.deepEqual(rows("gemini", "g1").map((x) => x.role), ["user", "assistant", "tool"]);
  assert.equal(rows("gemini", "g2").length, 0);
});

test("vscdb (Cursor/VS Code/Windsurf): tool-only messages tagged tool, tool calls not mixed into text", () => {
  const file = path.join(tmp("mem-vscdb-"), "state.vscdb");
  const d = new DatabaseSync(file);
  d.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  const chat = {
    workspace: "/tmp/ingest-vscdb",
    messages: [
      { role: "user", ts: 1795000001000, content: "Rename the config loader" },
      { role: "assistant", ts: 1795000002000, content: [{ type: "text", text: "Renamed loadConfig to readConfig." }, { type: "tool_use", name: "edit", input: "src/config.ts" }] },
      { role: "user", ts: 1795000003000, content: [{ type: "tool_result", content: "File updated" }] },
    ],
  };
  d.prepare("INSERT INTO ItemTable VALUES ('workbench.chat.sessions', ?)").run(JSON.stringify(chat));
  d.close();
  scanVscdb("cursor", [file]);
  const r = rows("cursor", "cursor:workbench.chat.sessions");
  assert.deepEqual(r.map((x) => x.role), ["user", "assistant", "tool"]);
  assert.equal(r[1].content, "Renamed loadConfig to readConfig.");
  assertUniqueSeq(r);
});

test("VS Code chatSessions: mutation log replayed, legacy .json read, project from workspace.json", () => {
  const { scanVscodeChatSessions, replayMutationLog } = require("../dist/engine/ingest/vscode-chat.js");
  const ws = tmp("mem-vscode-ws-");
  const repo = tmp("mem-vscode-repo-");
  const dir = path.join(ws, "abc123");
  fs.mkdirSync(path.join(dir, "chatSessions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.json"), JSON.stringify({ folder: "file://" + repo }));
  const req = (id, text, ts) => ({ requestId: id, message: { text, parts: [] }, variableData: { variables: [] }, response: [], timestamp: ts });
  const log = [
    { kind: 0, v: { version: 3, sessionId: "vs1", creationDate: 1795000000000, requests: [], responderUsername: "GitHub Copilot" } },
    { kind: 2, k: ["requests"], v: [req("r1", "Should we use zod or yup for form validation?", 1795000001000)] },
    { kind: 1, k: ["requests", 0, "response"], v: [
      { kind: "thinking", value: "internal" },
      { value: "Decided: zod instead of yup, because the types are inferred.", isTrusted: false },
      { kind: "toolInvocationSerialized", pastTenseMessage: { value: "Read package.json" } },
    ] },
    { kind: 2, k: ["requests"], v: [req("r2", "Add a schema for the signup form", 1795000002000)] },
    { kind: 2, k: ["requests"], i: 1, v: [req("r2b", "Add a zod schema for the signup form", 1795000003000)] },
  ];
  fs.writeFileSync(path.join(dir, "chatSessions", "vs1.jsonl"), log.map((l) => JSON.stringify(l)).join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "chatSessions", "old.json"), JSON.stringify({ sessionId: "vs-old", creationDate: 1794000000000, requests: [req("o1", "Rename the util module", 1794000001000)] }));

  const state = replayMutationLog(fs.readFileSync(path.join(dir, "chatSessions", "vs1.jsonl"), "utf8").split("\n"));
  assert.deepEqual(state.requests.map((r) => r.requestId), ["r1", "r2b"], "push with i truncates (edited request)");

  assert.ok(scanVscodeChatSessions(ws, "vscode") >= 4);
  const r = rows("vscode", "vs1");
  assert.deepEqual(r.map((x) => x.role), ["user", "assistant", "tool", "user"]);
  assert.equal(r[1].content, "Decided: zod instead of yup, because the types are inferred.", "thinking parts skipped");
  assert.equal(r[2].content, "Read package.json");
  assert.equal(rows("vscode", "vs-old").length, 1);
  const proj = dbmod.getDb().prepare("SELECT p.path FROM transcripts t JOIN projects p ON p.id = t.project_id WHERE t.session_id = 'vs1' LIMIT 1").get();
  assert.equal(proj.path, fs.realpathSync(repo));
  assert.equal(scanVscodeChatSessions(ws, "vscode"), 0, "unchanged files are skipped");
});

test("Cursor composer: inline conversation and bubble-header formats, project from workspace", () => {
  const { scanCursorComposer } = require("../dist/engine/ingest/vscode-chat.js");
  const gs = tmp("mem-cursor-gs-");
  const ws = tmp("mem-cursor-ws-");
  const repo = tmp("mem-cursor-repo-");
  const g = new DatabaseSync(path.join(gs, "state.vscdb"));
  g.exec("CREATE TABLE ItemTable (key TEXT, value TEXT); CREATE TABLE cursorDiskKV (key TEXT, value BLOB)");
  const kv = g.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
  kv.run("composerData:c-old", JSON.stringify({ composerId: "c-old", createdAt: 1795000000000, conversation: [
    { type: 1, text: "Why is the build slow?" },
    { type: 2, text: "The build was slow because source maps were on in production; disabled them." },
  ] }));
  kv.run("composerData:c-new", JSON.stringify({ composerId: "c-new", createdAt: 1795000100000, fullConversationHeadersOnly: [{ bubbleId: "b1", type: 1 }, { bubbleId: "b2", type: 2 }] }));
  kv.run("bubbleId:c-new:b1", JSON.stringify({ type: 1, text: "Use pnpm workspaces for the monorepo?" }));
  kv.run("bubbleId:c-new:b2", JSON.stringify({ type: 2, text: "Yes: decided on pnpm workspaces instead of Lerna." }));
  g.close();
  const wdir = path.join(ws, "h1");
  fs.mkdirSync(wdir);
  fs.writeFileSync(path.join(wdir, "workspace.json"), JSON.stringify({ folder: "file://" + repo }));
  const w = new DatabaseSync(path.join(wdir, "state.vscdb"));
  w.exec("CREATE TABLE ItemTable (key TEXT, value TEXT)");
  w.prepare("INSERT INTO ItemTable VALUES ('composer.composerData', ?)").run(JSON.stringify({ allComposers: [{ composerId: "c-new" }] }));
  w.close();

  assert.equal(scanCursorComposer(gs, ws, "cursor"), 4);
  assert.deepEqual(rows("cursor", "composer:c-old").map((x) => x.role), ["user", "assistant"]);
  assert.equal(rows("cursor", "composer:c-new")[1].content, "Yes: decided on pnpm workspaces instead of Lerna.");
  const proj = dbmod.getDb().prepare("SELECT p.path FROM transcripts t JOIN projects p ON p.id = t.project_id WHERE t.session_id = 'composer:c-new' LIMIT 1").get();
  assert.equal(proj.path, fs.realpathSync(repo));
  assert.equal(scanCursorComposer(gs, ws, "cursor"), 0, "unchanged database skipped");
});

test("antigravity brain: user request unwrapped, planner = assistant, tool steps = tool, SYSTEM skipped, project from paths", async () => {
  const root = tmp("mem-agy-");
  const repo = tmp("mem-agy-repo-");
  fs.writeFileSync(path.join(repo, "package.json"), "{}");
  fs.mkdirSync(path.join(repo, "src"));
  const file = path.join(root, "brain", "conv-1", ".system_generated", "logs", "transcript_full.jsonl");
  jsonl(file, [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: iso(1), content: `<USER_REQUEST>\nRefactor @[${repo}/src/app.ts] to use hooks\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>` },
    { step_index: 1, source: "SYSTEM", type: "CONVERSATION_HISTORY", created_at: iso(2), content: "# Conversation History" },
    { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", created_at: iso(3), content: "Decided to use a custom useSession hook instead of context." },
    { step_index: 3, source: "MODEL", type: "VIEW_FILE", created_at: iso(4), content: "Created At: x\nCompleted At: y\nFile Path: app.ts" },
  ]);
  // Duplicate copies Antigravity also writes must be ignored.
  jsonl(path.join(root, "brain", "conv-1", ".system_generated", "logs", "transcript.jsonl"), [{ type: "USER_INPUT", source: "USER_EXPLICIT", content: "dup" }]);
  await scanAntigravityBrain(root);
  const r = rows("antigravity", "conv-1");
  assert.deepEqual(r.map((x) => x.role), ["user", "assistant", "tool"]);
  assert.equal(r[0].content, `Refactor @[${repo}/src/app.ts] to use hooks`);
  assert.equal(r[2].content, "File Path: app.ts");
  const proj = dbmod.getDb().prepare("SELECT p.path FROM transcripts t JOIN projects p ON p.id = t.project_id WHERE t.session_id = 'conv-1' LIMIT 1").get();
  assert.equal(proj.path, fs.realpathSync(repo), "project = nearest folder with package.json");
  await scanAntigravityBrain(root);
  assert.equal(rows("antigravity", "conv-1").length, 3, "incremental re-scan adds nothing");
  assert.equal(cleanUserInput("plain text"), "plain text");
});
