/* `memoria doctor`: read-only checks with a level and a fix. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-doc-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-doc-"));
after(() => setTimeout(() => process.exit(0), 10));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
const { runDoctor, formatDoctor } = require("../dist/engine/doctor.js");

test("doctor: fresh install has no failures; warnings carry a fix", async () => {
  const checks = await runDoctor({ network: false });
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(by["Database integrity"].level, "ok");
  assert.equal(by["Schema version"].level, "ok");
  assert.equal(by["Schema version"].detail, `v${dbmod.LATEST_SCHEMA} (this build: v${dbmod.LATEST_SCHEMA})`);
  assert.equal(by["Backups"].level, "warn");
  assert.equal(by["Backups"].fix, "memoria backup");
  assert.ok(!checks.some((c) => c.level === "fail"), formatDoctor(checks));
  for (const c of checks.filter((c) => c.level !== "ok")) assert.ok(c.fix, `${c.name} needs a fix line`);
  assert.match(formatDoctor(checks), /Healthy/);
});

test("doctor: loose permissions and a turned-off API token are reported", async () => {
  if (process.platform === "win32") return;
  fs.chmodSync(process.env.MEMORIA_DATA_DIR, 0o755);
  dbmod.setSetting("apiTokenRequired", "0");
  const checks = await runDoctor({ network: false });
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  assert.equal(by["Data folder permissions"].level, "fail");
  assert.match(by["Data folder permissions"].fix, /chmod 700/);
  assert.equal(by["Local API token"].level, "warn");
  assert.match(formatDoctor(checks), /1 problem/);
  fs.chmodSync(process.env.MEMORIA_DATA_DIR, 0o700);
  dbmod.setSetting("apiTokenRequired", "1");
});
