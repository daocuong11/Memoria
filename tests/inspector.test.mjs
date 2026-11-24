/* Retrieval inspector (Q1.5): MCP context tools log what they returned,
 * queries are redacted, the log is capped, "not relevant" marks are checked
 * against the logged hits and survive a cleared log, and the HTTP API serves
 * it all. Real MCP client over an in-memory transport. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-insp-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-insp-home-"));
process.env.MEMORIA_DATA_DIR = dataDir;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MEMORIA_HTTP_PORT = String(49000 + Math.floor(Math.random() * 90));
const BASE = `http://127.0.0.1:${process.env.MEMORIA_HTTP_PORT}`;

const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(dataDir);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const insp = require("../dist/engine/retrieve/inspector.js");
const { createMcpServer } = require("../dist/engine/mcp/server.js");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const auth = require("../dist/engine/auth.js");
const { startHttpServer } = require("../dist/engine/http.js");
await startHttpServer();
after(() => setTimeout(() => process.exit(0), 10));

const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-insp-proj-"));
const pid = dbmod.ensureProject("insp-proj", projPath);
const mem = (kind, content) =>
  dbmod.insertMemory({ projectId: pid, kind, content, importance: 0.7, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active" });
const dbId = mem("decision", "We use SQLite FTS5 for keyword search because the app is offline-first.");
const taskId = mem("task_pending", "Add a parser test for the opencode todo table.");

async function connect() {
  const server = createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const H = { "x-memoria-token": auth.getApiToken(), "content-type": "application/json" };
const get = (p) => fetch(BASE + p, { headers: H }).then((r) => r.json());
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

test("MCP tools log their hits; empty results are logged too", async () => {
  const client = await connect();
  await client.callTool({ name: "recall", arguments: { query: "SQLite FTS5 keyword search", project: "insp-proj" } });
  await client.callTool({ name: "file_context", arguments: { path: "src/never/mentioned.ts" } });
  await client.callTool({ name: "project_context", arguments: { project: "insp-proj" } });
  await client.callTool({ name: "build_context", arguments: { project: "insp-proj", query: "opencode todo parser" } });

  const entries = insp.listRetrievals(10);
  const by = (s) => entries.filter((e) => e.source === s);
  const recall = by("recall").find((e) => e.query.includes("SQLite"));
  assert.ok(recall, "recall is logged with its query");
  assert.equal(recall.project, "insp-proj");
  assert.equal(recall.hits[0].id, dbId);
  assert.equal(typeof recall.hits[0].score, "number");
  assert.equal(recall.hits[0].kind, "decision");
  assert.ok(recall.servedChars > 0);
  const empty = by("file_context")[0];
  assert.equal(empty.query, "src/never/mentioned.ts");
  assert.deepEqual(empty.hits, [], "a call with no hit is logged with no hits");
  assert.ok(by("project_context")[0].hits.some((h) => h.id === taskId));
  const bc = by("build_context")[0];
  assert.equal(bc.query, "opencode todo parser");
  assert.ok(bc.hits.length >= 2, "build_context logs the memories placed in the block");
  assert.equal(new Set(bc.hits.map((h) => h.id)).size, bc.hits.length, "no duplicate ids");
});

test("queries are redacted and trimmed before they are stored", () => {
  const key = "sk-" + "a".repeat(40);
  const id = insp.logRetrieval("recall", null, `why does ${key} fail ` + "x".repeat(600), [], 0);
  const row = dbmod.getDb().prepare("SELECT query FROM retrieval_log WHERE id = ?").get(id);
  assert.ok(!row.query.includes(key), "secret must not reach the log");
  assert.ok(row.query.length <= 320);
});

test("not-relevant marks: only for logged hits, toggle, survive a cleared log", async () => {
  const e = insp.listRetrievals(20).find((x) => x.source === "recall" && x.hits.length);
  assert.equal(insp.markIrrelevant(e.id, 999999), false, "a memory that was not returned cannot be marked");
  assert.equal(insp.markIrrelevant(999999, e.hits[0].id), false);

  const r = await post("/api/retrievals/irrelevant", { logId: e.id, memoryId: e.hits[0].id });
  assert.equal(r.status, 200);
  let api = await get("/api/retrievals?limit=50");
  assert.equal(api.entries.find((x) => x.id === e.id).hits[0].irrelevant, true);
  assert.equal(api.stats.irrelevantMarks, 1);

  await post("/api/retrievals/irrelevant", { logId: e.id, memoryId: e.hits[0].id, on: false });
  assert.equal(insp.retrievalStats().irrelevantMarks, 0);

  insp.markIrrelevant(e.id, e.hits[0].id);
  await post("/api/retrievals/clear", {});
  api = await get("/api/retrievals");
  assert.equal(api.stats.entries, 0);
  assert.equal(api.stats.irrelevantMarks, 1, "marks outlive the log");
  const kept = dbmod.getDb().prepare("SELECT memory_id, query FROM retrieval_feedback").get();
  assert.equal(kept.memory_id, e.hits[0].id);
  assert.ok(kept.query.length > 0, "the mark keeps the query it was made for");
});

test("log is capped at LOG_CAP and can be paused", () => {
  for (let i = 0; i < insp.LOG_CAP + 120; i++) insp.logRetrieval("recall", null, `q${i}`, [{ id: 1 }], 10);
  insp.pruneRetrievalLog();
  const n = dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM retrieval_log").get().c;
  assert.equal(n, insp.LOG_CAP);
  assert.equal(insp.listRetrievals(1)[0].query, `q${insp.LOG_CAP + 119}`, "newest entries are kept");

  dbmod.setSetting("retrievalLog", "0");
  assert.equal(insp.logRetrieval("recall", null, "paused", [], 0), null);
  assert.equal(insp.retrievalStats().enabled, false);
  dbmod.setSetting("retrievalLog", "1");
});
