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

/* ---------- Q2b: verifier runs, file edits, commits ---------- */
const evmod = require("../dist/engine/ingest/events.js");
const { pairErrorFixes, errorFixContent } = require("../dist/engine/extract/events.js");

test("verifierName: allowlist, normalization, non-verifiers", () => {
  assert.equal(evmod.verifierName("cd web && npm run build 2>&1 | tail -20"), "npm run build");
  assert.equal(evmod.verifierName("pnpm build"), "pnpm run build");
  assert.equal(evmod.verifierName("npm test -- --run"), "npm test");
  assert.equal(evmod.verifierName("NODE_ENV=test npx tsc --noEmit -p ."), "npx tsc");
  assert.equal(evmod.verifierName("forge test -vvv"), "forge test");
  assert.equal(evmod.verifierName("python3 -m pytest -q"), "python -m pytest");
  assert.equal(evmod.verifierName("git status"), null);
  assert.equal(evmod.verifierName("npm install zod"), null);
  assert.equal(evmod.verifierName("cat tsconfig.json"), null);
});

test("runFailed: failure read from the output (pipes hide the exit code)", () => {
  const ts = "src/a.ts(3,5): error TS2304: Cannot find name 'foo'.\nFound 1 error.";
  assert.deepEqual(evmod.runFailed(ts, 0), { failed: true, errorLine: "error TS2304: Cannot find name 'foo'." });
  assert.equal(evmod.runFailed("Suite result: ok. 7 passed; 0 failed; 0 skipped", 0).failed, false, "0 failed is a pass");
  assert.equal(evmod.runFailed("✖ 2 problems (0 errors, 2 warnings)", 0).failed, false, "lint warnings are not a failure");
  assert.equal(evmod.runFailed("✖ 1 problem (1 error, 0 warnings)", 0).errorLine, "✖ 1 problem (1 error, 0 warnings)");
  assert.match(evmod.runFailed("Failed to compile.\n./app/page.tsx:4:1\nType error: Property 'x' does not exist", 0).errorLine, /^Type error:/, "the specific cause wins over the summary");
  assert.match(evmod.runFailed("Compiler run failed:\nError (7364): Different number of components", 0).errorLine, /^Error \(7364\)/);
  assert.deepEqual(evmod.runFailed("something odd happened", 2), { failed: true, errorLine: "" }, "exit code without an error line");
  assert.equal(evmod.runFailed("✓ Compiled successfully", null).failed, false);
});

test("errorBelongsTo: tsc needs a compiler error; environment errors never count", () => {
  assert.equal(evmod.errorBelongsTo("npx tsc", "error TS2304: Cannot find name 'x'."), true);
  assert.equal(evmod.errorBelongsTo("npx tsc", "SyntaxError: Unexpected end of JSON input"), false);
  assert.equal(evmod.errorBelongsTo("forge test", 'Error: server returned an error response: error code 3: execution reverted'), false);
  assert.equal(evmod.errorBelongsTo("npm run build", "Error: Cannot find module '/Users/me/app/probe.mjs'"), false);
  assert.equal(evmod.errorBelongsTo("npm run build", "Module not found: Can't resolve '../util'"), true);
});

test("commitFrom: -m, heredoc, root commit; no sha or nothing to commit → null", () => {
  assert.deepEqual(evmod.commitFrom('git add -A && git commit -m "fix(api): retry on 429"', "[main 1a2b3c4] fix(api): retry on 429\n 1 file changed"), { sha: "1a2b3c4", message: "fix(api): retry on 429" });
  assert.deepEqual(
    evmod.commitFrom("git commit -q -F - <<'EOF'\nfeat: dark mode toggle\n\n- details\nEOF\ngit log --oneline -1", "9f8e7d6 feat: dark mode toggle"),
    { sha: "9f8e7d6", message: "feat: dark mode toggle" }
  );
  assert.equal(evmod.commitFrom('git commit -m "first commit"', "[master (root-commit) c471820] first commit").sha, "c471820");
  assert.equal(evmod.commitFrom('git commit -q -m "chore: x"', ""), null, "no sha in the output");
  assert.equal(evmod.commitFrom('git commit -m "x"', "nothing to commit, working tree clean"), null);
  assert.equal(evmod.commitFrom("git status", "[main 1a2b3c4] x"), null);
});

test("isCodeFile: code and config yes; docs, locks, editor/agent settings no", () => {
  for (const p of ["src/a.ts", "app/page.tsx", "contracts/A.sol", "tsconfig.json", "app/globals.css", "foundry.toml"]) assert.equal(evmod.isCodeFile(p), true, p);
  for (const p of ["README.md", "package-lock.json", "/repo/.claude/settings.local.json", "/repo/.mcp.json", "notes.txt"]) assert.equal(evmod.isCodeFile(p), false, p);
});

test("pairErrorFixes: fail with an error line → code edits → same verifier passes", () => {
  let id = 0;
  const cmd = (verifier, failed, errorLine = "", ts = ++id) => ({ id: ts, ts, type: "command", payload: { verifier, failed, errorLine } });
  const edit = (path, ts = ++id) => ({ id: ts, ts, type: "file_edit", payload: { path, code: evmod.isCodeFile(path) } });
  const evs = [
    cmd("npx tsc", true, "error TS2304: Cannot find name 'foo'."),
    edit("README.md"),
    cmd("npm run build", true, ""), // no error line: cannot anchor a fix
    edit("/repo/src/a.ts"),
    cmd("npm run build", false),
    cmd("npx tsc", false), // → fix
    cmd("forge test", true, "[FAIL: x] test_y()"),
    cmd("forge test", false), // no code edit in between → no fix
    cmd("npm test", true, "AssertionError: expected 1 to equal 2"), // still open at the end
  ];
  const { fixes, open } = pairErrorFixes(evs);
  assert.equal(fixes.length, 1);
  assert.deepEqual(fixes[0].files, ["/repo/src/a.ts"], "only code files count");
  assert.equal(errorFixContent(fixes[0]), '`npx tsc` failed with "error TS2304: Cannot find name \'foo\'."; fixed by editing src/a.ts.');
  assert.deepEqual(open.map((o) => o.verifier), ["npm test"]);
});

test("claude fixture: verifier fail → edit → pass, commits, still-failing task closed later", async () => {
  const root = tmp("mem-ev-fix-");
  const cwd = "/tmp/ev-fix";
  const t0 = Date.UTC(2026, 10, 1, 10, 0, 0);
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const use = (s, id, name, input) => ({ type: "assistant", sessionId: "f1", cwd, gitBranch: "fix/types", timestamp: at(s), message: { content: [{ type: "tool_use", id, name, input }] } });
  const result = (s, id, text, extra = {}) => ({ type: "user", sessionId: "f1", cwd, timestamp: at(s), message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: false }] }, ...extra });
  const file = path.join(root, "p", "f1.jsonl");
  jsonl(file, [
    use(1, "b1", "Bash", { command: "npx tsc --noEmit 2>&1 | head" }),
    result(2, "b1", "src/a.ts(1,1): error TS2304: Cannot find name 'foo'."),
    use(3, "e1", "Edit", { file_path: `${cwd}/src/a.ts`, old_string: "foo", new_string: "bar" }),
    result(4, "e1", "The file has been updated successfully."),
    use(5, "b2", "Bash", { command: "npx tsc --noEmit 2>&1 | head" }),
    result(6, "b2", ""),
    use(7, "g1", "Bash", { command: 'git commit -m "fix(types): rename foo to bar"' }),
    result(8, "g1", "", { toolUseResult: { stdout: "[fix/types 0abc123] fix(types): rename foo to bar\n 1 file changed", stderr: "" } }),
    use(9, "g2", "Bash", { command: 'git commit -m "chore: bump deps"' }),
    result(10, "g2", "[fix/types 0abc124] chore: bump deps"),
    use(11, "b3", "Bash", { command: "npm test 2>&1 | tail -5" }),
    result(12, "b3", "✖ adds two numbers\nAssertionError [ERR_ASSERTION]: Expected 3, got 4"),
  ]);
  await scanClaude(file);
  const types = dbmod.sessionEvents({ tool: "claude", sessionId: "f1" }).map((e) => e.type);
  assert.deepEqual(types, ["command", "file_edit", "command", "commit", "commit", "command"]);

  await materializeEvents(embed, { now: t0 + 30 * 60_000 }); // 30 min later: still active
  const q = (sql) => mem(sql).map((r) => ({ ...r }));
  assert.deepEqual(q("SELECT kind, content FROM memories WHERE source_session = 'f1' AND kind = 'error_fixed' ORDER BY content"), [
    { kind: "error_fixed", content: '`npx tsc` failed with "error TS2304: Cannot find name \'foo\'."; fixed by editing src/a.ts.' },
    { kind: "error_fixed", content: "fix(types): rename foo to bar" },
  ]);
  assert.equal(q("SELECT git_commit FROM memories WHERE content = 'fix(types): rename foo to bar'")[0].git_commit, "0abc123");
  assert.equal(q("SELECT COUNT(*) AS c FROM memories WHERE content LIKE 'chore:%'")[0].c, 0, "only fix/feat commits become memories");
  assert.equal(q("SELECT COUNT(*) AS c FROM memories WHERE content LIKE '%still fails%'")[0].c, 0, "not yet: the session may still be fixing it");

  await materializeEvents(embed, { now: t0 + 2 * 3600_000 }); // quiet for over an hour
  const task = q("SELECT id, kind, memory_class, archived FROM memories WHERE content LIKE '`npm test` still fails%'");
  assert.equal(task.length, 1);
  assert.equal(task[0].memory_class, "working");

  // The session resumes: edit + passing run closes the task.
  fs.appendFileSync(file, [
    use(9000, "e2", "Write", { file_path: `${cwd}/src/sum.ts`, content: "export const sum = (a, b) => a + b;" }),
    result(9001, "e2", "File created successfully at: x"),
    use(9002, "b4", "Bash", { command: "npm test 2>&1 | tail -5" }),
    result(9003, "b4", "✔ adds two numbers\n# pass 1\n# fail 0"),
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  await scanClaude(file);
  await materializeEvents(embed, { now: t0 + 9010 * 1000 });
  assert.equal(q("SELECT archived FROM memories WHERE content LIKE '`npm test` still fails%'")[0].archived, 1, "closed by the later pass");
  assert.equal(q("SELECT COUNT(*) AS c FROM memories WHERE kind = 'error_fixed' AND content LIKE '`npm test`%'")[0].c, 1);
});

test("a feat/fix commit closes the open task it names; recall marks event memories", async () => {
  const { commitCoversTask } = require("../dist/engine/extract/events.js");
  assert.equal(commitCoversTask("feat(importer): retry on locked database", "Add a retry to the importer for locked databases"), true);
  assert.equal(commitCoversTask("fix: typo in README", "Add a retry to the importer for locked databases"), false);
  const pid = dbmod.ensureProject("ev-commit", "/tmp/ev-commit");
  const taskId = dbmod.insertMemory({ projectId: pid, kind: "task_pending", content: "Add a retry to the importer for locked databases", importance: 0.6, createdAt: 1000, sourceTool: "claude", status: "active", origin: "heuristic" });
  dbmod.insertSessionEvent({ tool: "claude", sessionId: "cm", projectId: pid, ts: 5000, type: "commit", sourceRef: "c1:commit", payload: { sha: "abc1234", message: "feat(importer): retry on locked database" } });
  await materializeEvents(embed);
  const t = dbmod.getDb().prepare("SELECT kind, resolved_at FROM memories WHERE id = ?").get(taskId);
  assert.equal(t.kind, "task_done");
  assert.ok(t.resolved_at > 0);

  const { createMcpServer } = require("../dist/engine/mcp/server.js");
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const server = createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await client.callTool({ name: "recall", arguments: { query: "retry importer locked database", project: "/tmp/ev-commit" } });
  const text = r.content.map((c) => c.text).join("\n");
  assert.match(text, /from event/);
});
