/* Q7: lite toolset, default output caps, and the leaner resume block
 * (last turn report instead of raw messages, no turn reports in the memory
 * list, no lines repeated from the resume section). */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tools-"));
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tools-home-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const mcp = require("../dist/engine/mcp/server.js");
const { generateHandoff } = require("../dist/engine/handoff.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
after(() => delete process.env.MEMORIA_MCP_TOOLS);

async function connect() {
  const server = mcp.createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("toolset: full by default, lite via env or setting, lite under 600 tokens", async () => {
  delete process.env.MEMORIA_MCP_TOOLS;
  let c = await connect();
  const full = (await c.listTools()).tools;
  assert.equal(full.length, 9);
  process.env.MEMORIA_MCP_TOOLS = "lite";
  c = await connect();
  const lite = (await c.listTools()).tools;
  assert.deepEqual(lite.map((t) => t.name), ["recall", "project_context", "remember"]);
  assert.ok(JSON.stringify(lite).length / 4 < 600, `lite is ${Math.round(JSON.stringify(lite).length / 4)} tokens`);
  assert.ok(JSON.stringify(full).length / 4 < 1100);
  delete process.env.MEMORIA_MCP_TOOLS;
  dbmod.setSetting("mcpTools", "lite");
  assert.equal(mcp.toolset(), "lite");
  dbmod.setSetting("mcpTools", "full");
});

test("capText: default cap per tool, maxChars overrides, short text untouched", () => {
  const long = "x".repeat(10_000);
  assert.equal(mcp.capText("short", "recall"), "short");
  const r = mcp.capText(long, "recall");
  assert.ok(r.length < mcp.DEFAULT_CAPS.recall + 120 && r.includes("truncated at 4000"));
  assert.ok(mcp.capText(long, "recall", 500).includes("truncated at 500"));
  assert.equal(mcp.capText(long, "unknown_tool"), long);
});

test("resume block: last turn report, no turn reports in the list, no repeats", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tools-proj-"));
  const pid = dbmod.ensureProject("tools-proj", root);
  const slug = dbmod.projectSlugById(pid);
  const now = Date.now();
  const add = (over) => dbmod.insertMemory({ projectId: pid, importance: 0.6, createdAt: now, sourceTool: "claude", status: "active", origin: "heuristic", ...over });
  add({ kind: "context", content: "Older turn report: set up the repo and the CI workflow.", memoryClass: "working", expiresAt: now + 86_400_000, createdAt: now - 5000 });
  add({ kind: "context", content: "Latest turn report: the importer now skips archived rows; tests pass.", memoryClass: "working", expiresAt: now + 86_400_000 });
  add({ kind: "task_pending", content: "Add a retry to the importer for locked databases" });
  add({ kind: "decision", content: "Keputusan: pakai node:sqlite daripada better-sqlite3 karena tanpa native build." });
  dbmod.insertTranscript({ tool: "claude", sessionId: "s1", projectId: pid, role: "tool", content: "RAW TOOL OUTPUT should not appear", ts: now, seq: 1 });
  const block = await generateHandoff(slug, { slim: true });
  assert.match(block, /\*\*Last turn:\*\* Latest turn report/);
  assert.ok(!block.includes("Older turn report"), "older turn reports stay out of the block");
  assert.ok(!block.includes("RAW TOOL OUTPUT"), "raw tool output never reaches the block");
  const n = block.split("Add a retry to the importer").length - 1;
  assert.equal(n, 1, "an open task listed in the resume section is not repeated below");
});

test("injection guard: never the home folder or a root; MEMORIA_NO_INJECT=1 turns it off", () => {
  const { injectableFolder } = require("../dist/engine/handoff.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-inj-"));
  assert.equal(injectableFolder(dir), true);
  assert.equal(injectableFolder(os.homedir()), false);
  assert.equal(injectableFolder(path.parse(dir).root), false);
  assert.equal(injectableFolder(path.join(dir, "missing")), false);
  process.env.MEMORIA_NO_INJECT = "1";
  assert.equal(injectableFolder(dir), false);
  delete process.env.MEMORIA_NO_INJECT;
});

test("resume block (structured policy): unreviewed heuristic drafts are not listed as open tasks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-tools-draft-"));
  const pid = dbmod.ensureProject("tools-draft", root);
  dbmod.insertMemory({ projectId: pid, kind: "task_pending", content: "Ini, tinggal copy-paste captionnya ke thread nanti", importance: 0.6, createdAt: Date.now(), sourceTool: "opencode", status: "draft", origin: "heuristic" });
  const block = await generateHandoff(dbmod.projectSlugById(pid), { slim: true });
  assert.ok(!block.includes("tinggal copy-paste"), block);
});
