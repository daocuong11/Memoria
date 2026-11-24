/* Q4 evidence score: learned weights plus runtime signals. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-evid-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
const { evidenceTriage, rescoreStored } = require("../dist/engine/extract/heuristic.js");
const { evidenceProbability, features, ARCHIVE_BELOW, ACTIVE_FROM } = require("../dist/engine/extract/evidence.js");
const { planTriage } = require("../dist/engine/extract/triage.js");

const decision = { kind: "decision", content: "Keputusan: kita pakai Stripe daripada Midtrans karena butuh subscription.", importance: 0.6 };

test("evidence: thresholds ordered, features fixed-length, noise still archived by rule", () => {
  assert.ok(ARCHIVE_BELOW < ACTIVE_FROM);
  const t = evidenceTriage(decision);
  assert.equal(features({ kind: "decision", content: decision.content, triage: t }).length, 22);
  assert.equal(t.decision, "active");
  assert.equal(typeof t.evidence, "number");
  const noise = evidenceTriage({ kind: "fact", content: "The file /x/a.ts has been updated successfully.", importance: 0.5 });
  assert.equal(noise.decision, "archive");
  assert.match(noise.reason, /^noise:/);
});

test("evidence: runtime signals move the probability within bounds", () => {
  const t = evidenceTriage(decision);
  const base = { kind: "decision", content: decision.content, triage: t };
  const p0 = evidenceProbability(base);
  assert.ok(evidenceProbability(base, { irrelevantMarks: 1 }) < p0);
  assert.ok(evidenceProbability(base, { irrelevantMarks: 10 }) >= p0 - 0.45 - 1e-9, "marks are capped");
  const weak = { kind: "fact", content: "Port default service ini kemungkinan 8080 di environment lokal.", triage: evidenceTriage({ kind: "fact", content: "Port default service ini kemungkinan 8080 di environment lokal.", importance: 0.5 }) };
  assert.ok(evidenceProbability(weak, { fromEvent: true }) > evidenceProbability(weak));
  assert.ok(evidenceProbability(weak, { accessCount: 50 }) <= evidenceProbability(weak) + 0.1 + 1e-9);
});

test("evidence: a checklist item is never archived by the score alone; self-labelled lines get credit", () => {
  const cb = rescoreStored({ kind: "task_pending", content: "- [ ] migrate the old embeddings to Float32 BLOB", importance: 0.6 });
  assert.notEqual(cb.decision, "archive");
  const todo = rescoreStored({ kind: "task_pending", content: "TODO: tambahkan webhook handler untuk invoice.paid.", importance: 0.6 });
  assert.equal(todo.decision, "active");
});

test("planTriage: a memory marked not relevant in the inspector is ranked lower", () => {
  const pid = dbmod.ensureProject("evid-proj", "/tmp/evid-proj");
  const content = "Keputusan: pakai Redis untuk cache sesi karena butuh TTL per key.";
  const id = dbmod.insertMemory({ projectId: pid, kind: "decision", content, importance: 0.6, createdAt: Date.now(), sourceTool: "claude", status: "draft", origin: "heuristic" });
  const before = planTriage().find((x) => x.id === id);
  const d = dbmod.getDb();
  for (let i = 1; i <= 3; i++) {
    d.prepare("INSERT INTO retrieval_log (ts, source, query, hits) VALUES (?, 'recall', 'cache', ?)").run(Date.now(), JSON.stringify([{ id }]));
    const logId = d.prepare("SELECT MAX(id) AS m FROM retrieval_log").get().m;
    d.prepare("INSERT INTO retrieval_feedback (log_id, memory_id, ts) VALUES (?, ?, ?)").run(logId, id, Date.now());
  }
  const after = planTriage().find((x) => x.id === id);
  assert.equal(before.action, "promote");
  assert.notEqual(after.action, "promote", "three not-relevant marks keep it out of active");
});

test("structured policy (default): sentences stay drafts, recall still finds them; evidence policy promotes", async () => {
  const { searchMemories } = require("../dist/engine/retrieve/search.js");
  const strong = { kind: "decision", content: "Kita pakai Redis daripada Memcached karena butuh TTL per key dan pub/sub.", importance: 0.6 };
  dbmod.setSetting("tier0Promote", "structured");
  assert.notEqual(evidenceTriage(strong).decision, "active", "a sentence is not served proactively by default");
  assert.equal(evidenceTriage({ ...strong, content: "Keputusan: " + strong.content }).decision, "active", "self-labelled lines still are");
  dbmod.setSetting("tier0Promote", "evidence");
  assert.equal(evidenceTriage(strong).decision, "active");
  dbmod.setSetting("tier0Promote", "structured");

  const pid = dbmod.ensureProject("evid-recall", "/tmp/evid-recall");
  const id = dbmod.insertMemory({ projectId: pid, kind: "decision", content: "Pakai pgbouncer transaction mode untuk Neon karena koneksi serverless", importance: 0.6, createdAt: Date.now(), sourceTool: "claude", status: "draft", origin: "heuristic" });
  assert.ok(!searchMemories("pgbouncer transaction mode neon", { limit: 5 }).some((h) => h.id === id), "drafts are not in default search");
  const hit = searchMemories("pgbouncer transaction mode neon", { limit: 5, includeDrafts: true }).find((h) => h.id === id);
  assert.ok(hit && hit.draft === true, "recall (includeDrafts) finds and marks it");
});
