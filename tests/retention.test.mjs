/* Q6: transcript retention (gzip archive by default, delete opt-in, latest
 * session per project and unextracted rows kept, restore round trip) and the
 * redaction rules added with it (labelled hex keys, keypair byte arrays). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-ret-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
const { planRetention, applyRetention, restoreTranscripts } = require("../dist/engine/store/retention.js");
const { redactSecrets } = require("../dist/engine/privacy/redact.js");

const DAY = 86_400_000;
const now = Date.now();
const pid = dbmod.ensureProject("ret-proj", "/tmp/ret-proj");
let seq = 0;
const row = (session, daysAgo, content, extracted = 1) => {
  dbmod.insertTranscript({ tool: "claude", sessionId: session, projectId: pid, role: "user", content, ts: now - daysAgo * DAY, seq: seq++ });
  if (extracted) dbmod.getDb().prepare("UPDATE transcripts SET extracted = 1 WHERE session_id = ? AND content = ?").run(session, content);
};
row("old", 200, "old session message one");
row("old", 199, "old session message two");
row("pending", 150, "old but never extracted", 0);
row("latest", 120, "latest session of the project, also old");
const count = () => dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM transcripts").get().c;

test("retention: preview, archive, restore; latest session and unextracted rows stay", () => {
  const p = planRetention(90, now);
  assert.equal(p.rows, 2, "only the extracted rows of a non-latest session");
  assert.equal(p.sessions, 1);
  const before = count();
  const r = applyRetention(90, { now });
  assert.equal(r.mode, "archive");
  assert.ok(r.file && fs.existsSync(r.file) && r.file.endsWith(".jsonl.gz"));
  assert.equal((fs.statSync(r.file).mode & 0o777).toString(8), "600");
  assert.equal(count(), before - 2);
  assert.equal(dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM transcripts WHERE session_id IN ('pending', 'latest')").get().c, 2);
  assert.equal(restoreTranscripts(r.file), 2);
  assert.equal(count(), before, "restore puts every row back");
  assert.equal(restoreTranscripts(r.file), 0, "restore is idempotent");
});

test("retention: --delete removes without an archive file", () => {
  const r = applyRetention(90, { now, mode: "delete" });
  assert.equal(r.rows, 2);
  assert.equal(r.file, null);
  assert.equal(planRetention(90, now).rows, 0);
});

test("redaction: labelled 32-byte hex keys and keypair arrays; tx hashes and addresses stay", () => {
  const key = "0x" + "ab".repeat(32);
  for (const t of [`Private key: ${key}`, `const pk = process.env.LENDER_PRIVATE_KEY || '${key}';`, `privateKeyToAccount("${key}")`]) {
    const r = redactSecrets(t);
    assert.equal(r.count, 1, t);
    assert.ok(!r.text.includes(key));
  }
  assert.equal(redactSecrets(`[${Array(64).fill(17).join(", ")}]`).text, "[REDACTED:keypair-bytes]");
  for (const t of [`transactionHash 0x${"12".repeat(32)}`, `tx: 0x${"34".repeat(32)}`, "EXECUTOR=0xb91E596EF3E1855df77bC34b2d094eF8704bB5AE", "mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"])
    assert.equal(redactSecrets(t).count, 0, t);
});

test("session event payloads stay valid JSON after redaction", () => {
  const id = dbmod.insertSessionEvent({ tool: "claude", sessionId: "e", projectId: pid, ts: now, type: "command", sourceRef: "r1", payload: { command: `cast send --private-key 0x${"cd".repeat(32)}`, keypair: Array(64).fill(3) } });
  const raw = dbmod.getDb().prepare("SELECT payload FROM session_events WHERE id = ?").get(id).payload;
  const p = JSON.parse(raw);
  assert.ok(!raw.includes("cd".repeat(32)));
  assert.equal(p.keypair, "[REDACTED:keypair-bytes]");
});
