/* M13: local session_events table and optional memory metadata
 * (git_branch, git_commit, memory_class, expires_at, source_event_id).
 * Sync rules: metadata travels in the memory payload, older bundles without
 * it keep local values, unknown fields from a newer version are ignored,
 * and session events never enter the sync outbox. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);
const dbmod = require("../dist/engine/store/db.js");
const { applySyncBundle } = require("../dist/engine/sync/apply.js");

function fresh(tag) {
  dbmod.closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `memoria-m13-${tag}-`));
  dbmod.initDb(dir);
  return dir;
}

function bundleOf(ops) {
  const hlcs = ops.map((o) => o.hlc).sort(dbmod.compareHlc);
  return {
    header: { v: 1, groupId: "g", fileId: randomUUID(), deviceId: "remote-device", createdAt: Date.now(), opCount: ops.length, hlcMin: hlcs[0], hlcMax: hlcs.at(-1), nonce: "" },
    ops,
  };
}

function memoryOp(uid, payload, hlc = dbmod.nextHlc("remote-device")) {
  return { opId: randomUUID(), hlc, entity: "memory", entityUid: uid, op: "upsert", payload };
}

test("session events: idempotent insert, redacted payload, filters, never synced", () => {
  fresh("ev");
  const pid = dbmod.ensureProject("ev-proj", "/tmp/ev-proj");
  const base = { tool: "claude", sessionId: "s1", projectId: pid, gitBranch: "feat/x" };
  const id1 = dbmod.insertSessionEvent({ ...base, ts: 1000, type: "todo", sourceRef: "u1", payload: { content: "Write the parser", status: "pending" } });
  assert.ok(id1);
  assert.equal(dbmod.insertSessionEvent({ ...base, ts: 1000, type: "todo", sourceRef: "u1", payload: { content: "again" } }), null, "same sourceRef is ignored");
  const key = "sk-" + "b".repeat(40);
  dbmod.insertSessionEvent({ ...base, ts: 2000, type: "command", sourceRef: "u2", payload: { command: `curl -H "Authorization: Bearer ${key}" x`, failed: true } });
  dbmod.insertSessionEvent({ ...base, sessionId: "s2", ts: 3000, type: "commit", sourceRef: "c1", payload: { sha: "abc1234" } });

  const all = dbmod.sessionEvents({ projectId: pid });
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.type), ["todo", "command", "commit"], "ordered by time");
  assert.equal(all[0].payload.content, "Write the parser");
  assert.equal(all[0].gitBranch, "feat/x");
  assert.ok(!JSON.stringify(all[1].payload).includes(key), "secrets are redacted");
  assert.equal(dbmod.sessionEvents({ types: ["commit"] }).length, 1);
  assert.equal(dbmod.sessionEvents({ sessionId: "s1", since: 1500 }).length, 1);

  const outbox = dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE entity NOT IN ('memory', 'project', 'link')").get().c;
  assert.equal(outbox, 0, "no session event reaches the sync outbox");
});

test("memory metadata: stored, read back, sent in the sync payload (except source_event_id)", () => {
  fresh("meta");
  const pid = dbmod.ensureProject("meta-proj", "/tmp/meta-proj");
  const ev = dbmod.insertSessionEvent({ tool: "opencode", sessionId: "s", projectId: pid, ts: 1, type: "todo", sourceRef: "p1", payload: {} });
  const id = dbmod.insertMemory({
    projectId: pid, kind: "task_pending", content: "Ship the todo parser", importance: 0.7, createdAt: Date.now(), sourceTool: "opencode",
    status: "active", origin: "heuristic", sourceEventId: ev, gitBranch: "feat/todo", gitCommit: "a1b2c3d", memoryClass: "working", expiresAt: 1234567,
  });
  const m = dbmod.memoryById(id);
  assert.equal(m.sourceEventId, ev);
  assert.equal(m.gitBranch, "feat/todo");
  assert.equal(m.gitCommit, "a1b2c3d");
  assert.equal(m.memoryClass, "working");
  assert.equal(m.expiresAt, 1234567);
  const lite = dbmod.readMemoriesLite("WHERE id = ?", [id])[0];
  assert.equal(lite.memoryClass, "working");

  const bad = dbmod.insertMemory({ projectId: pid, kind: "fact", content: "Unknown class falls back", importance: 0.5, createdAt: Date.now(), sourceTool: "t", memoryClass: "forever" });
  assert.equal(dbmod.memoryById(bad).memoryClass, "");

  const { payload } = dbmod.memorySyncPayload(id);
  assert.equal(payload.gitBranch, "feat/todo");
  assert.equal(payload.gitCommit, "a1b2c3d");
  assert.equal(payload.memoryClass, "working");
  assert.equal(payload.expiresAt, 1234567);
  assert.ok(!("sourceEventId" in payload), "event ids are local and never synced");
});

test("sync: new bundle carries metadata; an older bundle without it keeps local values; unknown fields are ignored", () => {
  fresh("apply");
  const uid = randomUUID();
  const base = { projectUid: null, kind: "decision", content: "Use node:sqlite", importance: 0.6, createdAt: 1000, updatedAt: 1000, updatedBy: "remote-device", sourceTool: "claude", status: "active", resolvedAt: 0, origin: "user", archived: 0, tags: [], supersededByUid: null, validTo: 0 };

  let r = applySyncBundle(bundleOf([memoryOp(uid, { ...base, gitBranch: "main", gitCommit: "ABCDEF1", memoryClass: "durable", expiresAt: 0 })]));
  assert.equal(r.applied, 1);
  let m = dbmod.allMemories().find((x) => x.uid === uid);
  assert.equal(m.gitBranch, "main");
  assert.equal(m.gitCommit, "abcdef1", "commit hashes are normalized");
  assert.equal(m.memoryClass, "durable");

  // A v0.16 device edits the memory: its payload has no metadata fields.
  r = applySyncBundle(bundleOf([memoryOp(uid, { ...base, content: "Use node:sqlite (no native deps)", updatedAt: 2000 })]));
  assert.equal(r.applied, 1);
  m = dbmod.allMemories().find((x) => x.uid === uid);
  assert.equal(m.content, "Use node:sqlite (no native deps)");
  assert.equal(m.gitBranch, "main", "an older bundle does not wipe metadata");
  assert.equal(m.memoryClass, "durable");

  // A future version adds fields this version does not know, and bad values.
  r = applySyncBundle(bundleOf([memoryOp(uid, { ...base, updatedAt: 3000, memoryClass: "forever", gitCommit: "not a sha", futureField: { x: 1 }, evidence: 0.9 })]));
  assert.equal(r.applied, 1);
  m = dbmod.allMemories().find((x) => x.uid === uid);
  assert.equal(m.memoryClass, "", "unknown class is rejected to unclassified");
  assert.equal(m.gitCommit, "", "invalid commit is dropped");
});

test("migration v13 keeps existing memories intact and is idempotent", () => {
  const dir = fresh("mig");
  const id = dbmod.insertMemory({ projectId: null, kind: "fact", content: "survives v13", importance: 0.5, createdAt: Date.now(), sourceTool: "t" });
  dbmod.closeDb();
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(dir, "memory.db"));
  raw.exec("PRAGMA user_version = 12");
  raw.close();
  const d = dbmod.initDb(dir);
  assert.equal(Number(d.prepare("PRAGMA user_version").get().user_version), 14);
  const m = dbmod.memoryById(id);
  assert.equal(m.content, "survives v13");
  assert.equal(m.memoryClass, "");
  assert.equal(m.expiresAt, 0);
  dbmod.closeDb();
});
