/* Q8: capture health per tool and parser isolation. A tool that keeps
 * writing while nothing is stored shows as "behind"; one bad transcript file
 * does not stop the scan; a failed scan shows as "error". */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-health-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-health-data-"));
after(() => setTimeout(() => process.exit(0), 10));

const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");
const { captureHealth, recordScan } = require("../dist/engine/ingest/health.js");
const { scanClaude } = require("../dist/engine/ingest/claude.js");

const projects = path.join(home, ".claude", "projects", "p");
fs.mkdirSync(projects, { recursive: true });
const good = path.join(projects, "good.jsonl");
const iso = (s) => new Date(Date.now() - 3 * 86_400_000 + s * 1000).toISOString();
fs.writeFileSync(good, JSON.stringify({ type: "user", sessionId: "h1", cwd: "/tmp/health-proj", timestamp: iso(1), message: { content: "Tambahkan health check" } }) + "\n");
const health = (tool) => captureHealth().find((h) => h.tool === tool);

test("behind before the first scan, ok after; missing tools are reported as missing", async () => {
  const before = health("claude");
  assert.equal(before.status, "behind");
  assert.match(before.reason, /nothing was stored yet/);
  assert.equal(health("codex").status, "missing");
  await scanClaude(path.join(home, ".claude", "projects"));
  // The file was written now, the message is 3 days old: behind by mtime.
  fs.utimesSync(good, new Date(Date.now() - 3 * 86_400_000), new Date(Date.now() - 3 * 86_400_000));
  const after = health("claude");
  assert.equal(after.status, "ok", after.reason);
  assert.equal(after.stored7d, 1);
});

test("one unreadable file does not stop the scan; its count is reported", async () => {
  const bad = path.join(projects, "a-bad.jsonl");
  fs.writeFileSync(bad, JSON.stringify({ type: "user", sessionId: "hx", message: { content: "x" } }) + "\n");
  fs.chmodSync(bad, 0o000); // unreadable: reading it throws
  const other = path.join(projects, "other.jsonl");
  fs.writeFileSync(other, JSON.stringify({ type: "user", sessionId: "h2", cwd: "/tmp/health-proj", timestamp: iso(5), message: { content: "Second session still captured" } }) + "\n");
  const r = await scanClaude(path.join(home, ".claude", "projects"));
  fs.chmodSync(bad, 0o644);
  if (process.platform !== "win32" && process.getuid?.() !== 0) assert.equal(r.fileErrors, 1, "the unreadable file is counted");
  assert.equal(dbmod.getDb().prepare("SELECT COUNT(*) AS c FROM transcripts WHERE session_id = 'h2'").get().c, 1, "the good file after a bad one is still read");
});

test("a failed scan shows as error; disabled sources as disabled", () => {
  recordScan("opencode", { ok: false, detail: "Error: database disk image is malformed", count: 0, ms: 3 });
  fs.mkdirSync(path.join(home, ".local", "share", "opencode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "share", "opencode", "opencode.db"), "");
  const oc = health("opencode");
  assert.equal(oc.status, "error");
  assert.match(oc.reason, /malformed/);
  dbmod.setSetting("source:codex:enabled", "0");
  assert.equal(health("codex").status, "disabled");
});
