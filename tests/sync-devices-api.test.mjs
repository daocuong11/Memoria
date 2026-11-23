/* Dashboard sync controls: device list, key rotation, device revocation. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-syncui-"));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-syncui-home-"));
const shared = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-syncui-shared-"));
process.env.MEMORIA_DATA_DIR = dataDir;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.MEMORIA_HTTP_PORT = String(48900 + Math.floor(Math.random() * 90));
const BASE = `http://127.0.0.1:${process.env.MEMORIA_HTTP_PORT}`;
const PASS = "sync-ui-test-passphrase";
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(dataDir);
const keys = require("../dist/engine/sync/keys.js");
const folder = require("../dist/engine/sync/folder.js");
const auth = require("../dist/engine/auth.js");
const { startHttpServer } = require("../dist/engine/http.js");
await startHttpServer();
after(() => setTimeout(() => process.exit(0), 10));
const H = { "x-memoria-token": auth.getApiToken(), "content-type": "application/json" };
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const get = (p) => fetch(BASE + p, { headers: H }).then((r) => r.json());

test("devices: not configured, then this device", async () => {
  assert.equal((await get("/api/sync/devices")).configured, false);
  keys.setupSync({ passphrase: PASS, deviceName: "laptop" });
  folder.setSharedFolder(shared, { passphrase: PASS });
  const d = await get("/api/sync/devices");
  assert.equal(d.configured, true);
  assert.equal(d.devices.length, 1);
  assert.equal(d.devices[0].self, true);
  assert.equal(d.devices[0].name, "laptop");
});

test("rotate on an empty database still returns the recovery code", async () => {
  const r = await post("/api/sync/rotate", { confirm: true, passphrase: PASS });
  assert.equal(r.status, 200);
  assert.ok(r.recoveryCode, "recovery code is never lost");
  assert.match(r.republishError, /empty/);
  assert.equal(r.republished, null);
});

test("rotate needs confirm and the passphrase, then returns a recovery code and republishes", async () => {
  const before = keys.syncStatus({ passphrase: PASS }).groupId;
  dbmod.insertMemory({ projectId: null, kind: "fact", content: "Staging uses Postgres 16.", importance: 0.5, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "user" });
  assert.equal((await post("/api/sync/rotate", { passphrase: PASS })).status, 400, "no confirm");
  const wrong = await post("/api/sync/rotate", { confirm: true, passphrase: "nope" });
  assert.equal(wrong.status, 400);
  assert.equal(keys.syncStatus({ passphrase: PASS }).groupId, before, "failed attempt leaves the key alone");
  const r = await post("/api/sync/rotate", { confirm: true, passphrase: PASS });
  assert.equal(r.status, 200);
  assert.equal(r.previousGroupId, before);
  assert.notEqual(r.groupId, before);
  assert.ok(r.recoveryCode.length > 20);
  assert.ok(r.republished && fs.existsSync(r.republished.filePath), "full export written to the shared folder");
});

test("revoke: requires a device id, refuses this device, marks another one revoked", async () => {
  assert.equal((await post("/api/sync/revoke", { confirm: true, passphrase: PASS })).status, 400, "no device id");
  const self = keys.getDeviceId ? keys.getDeviceId() : (await get("/api/sync/devices")).devices.find((d) => d.self).deviceId;
  const mine = await post("/api/sync/revoke", { confirm: true, passphrase: PASS, deviceId: self });
  assert.equal(mine.status, 400);
  const before = keys.syncStatus({ passphrase: PASS }).groupId;
  const r = await post("/api/sync/revoke", { confirm: true, passphrase: PASS, deviceId: "old-phone-0000" });
  assert.equal(r.status, 200);
  assert.equal(r.revokedDeviceId, "old-phone-0000");
  assert.notEqual(r.groupId, before);
  const d = await get("/api/sync/devices");
  assert.ok(d.devices.some((x) => x.deviceId === "old-phone-0000" && x.revoked));
});
