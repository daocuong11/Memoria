#!/usr/bin/env node
/* Sync compatibility check across versions: a bundle exported by THIS build
 * must apply on an older release, and a bundle from the older release must
 * apply here. Each side runs in its own process with its own data dir and
 * HOME, so the real ~/.memoria is never touched.
 *
 *   npm pack @xinzzu/memoria@0.16.3 && tar xzf xinzzu-memoria-0.16.3.tgz
 *   node scripts/compat-sync.mjs ./package/dist
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const NEW_DIST = path.resolve(here, "..", "dist");
const OLD_DIST = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(path.join(OLD_DIST, "engine", "sync", "apply.js"))) {
  console.error("Usage: node scripts/compat-sync.mjs <old-release>/dist");
  process.exit(2);
}
const PASS = "compat-sync-passphrase";
const shared = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-compat-shared-"));

/** Run `body` (source of an async function receiving the dist path) in a fresh process. */
function side(dist, dataDir, body, input = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-compat-home-"));
  const code = `
    const { createRequire } = require("node:module");
    const req = createRequire(${JSON.stringify(path.join(dist, "engine", "x.js"))});
    const db = req("./store/db.js"); db.initDb(process.env.MEMORIA_DATA_DIR);
    const keys = req("./sync/keys.js"); const folder = req("./sync/folder.js");
    const input = ${JSON.stringify(input)};
    (async () => { const out = await (${body})({ db, keys, folder, input, PASS: ${JSON.stringify(PASS)}, shared: ${JSON.stringify(shared)} });
      process.stdout.write("\\n@@" + JSON.stringify(out)); })().catch((e) => { console.error(e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, HOME: home, USERPROFILE: home, MEMORIA_DATA_DIR: dataDir, NODE_PATH: path.resolve(here, "..", "node_modules") },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`side failed (${dist}):\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.split("\n@@").pop());
}

const newDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-compat-new-"));
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-compat-old-"));

// 1. New build: create a memory with v13 metadata and export.
const a = side(NEW_DIST, newDir, `async ({ db, keys, folder, PASS, shared }) => {
  const setup = keys.setupSync({ passphrase: PASS, deviceName: "new" });
  folder.setSharedFolder(shared, { passphrase: PASS });
  const pid = db.ensureProject("compat-proj", "/tmp/compat-proj");
  db.insertMemory({ projectId: pid, kind: "decision", content: "compat: written by the new build", importance: 0.7, createdAt: Date.now(),
    sourceTool: "claude", status: "active", origin: "user", gitBranch: "feat/compat", gitCommit: "abc1234", memoryClass: "durable", expiresAt: 0 });
  const ex = folder.exportPendingToFolder({ passphrase: PASS });
  const uv = Number(db.getDb().prepare("PRAGMA user_version").get().user_version);
  return { recovery: setup.recoveryCode, exported: ex.exported, userVersion: uv };
}`);

// 2. Old release: join, apply the new bundle, write its own memory, export.
const b = side(OLD_DIST, oldDir, `async ({ db, keys, folder, input, PASS, shared }) => {
  keys.setupSync({ joinCode: input.recovery, passphrase: PASS, deviceName: "old" });
  folder.setSharedFolder(shared, { passphrase: PASS });
  const scan = await folder.scanAndApplyFolder({ passphrase: PASS });
  const got = db.allMemories().find((m) => m.content === "compat: written by the new build");
  const pid = db.ensureProject("compat-proj", "/tmp/compat-proj");
  db.insertMemory({ projectId: pid, kind: "fact", content: "compat: written by the old release", importance: 0.6, createdAt: Date.now(), sourceTool: "codex", status: "active", origin: "user" });
  if (got) db.updateMemory(got.id, { content: "compat: written by the new build, edited on the old release" });
  const ex = folder.exportPendingToFolder({ passphrase: PASS });
  const uv = Number(db.getDb().prepare("PRAGMA user_version").get().user_version);
  return { applied: scan.applied, failed: scan.failed, found: !!got, kind: got && got.kind, exported: ex.exported, userVersion: uv };
}`, { recovery: a.recovery });

// 3. New build: apply the old bundle; metadata must survive the old edit.
const c = side(NEW_DIST, newDir, `async ({ db, folder, PASS }) => {
  const scan = await folder.scanAndApplyFolder({ passphrase: PASS });
  const mems = db.allMemories();
  const edited = mems.find((m) => m.content.startsWith("compat: written by the new build"));
  return { applied: scan.applied, failed: scan.failed,
    oldMemory: mems.some((m) => m.content === "compat: written by the old release"),
    editedContent: edited && edited.content, gitBranch: edited && edited.gitBranch, memoryClass: edited && edited.memoryClass };
}`);

const checks = [
  ["new build exported a bundle", a.exported > 0],
  [`old release (schema v${b.userVersion}) applied it without failures`, b.failed === 0 && b.applied >= 1],
  ["old release received the memory with its kind", b.found && b.kind === "decision"],
  ["old release exported its changes", b.exported > 0],
  [`new build (schema v${a.userVersion}) applied the old bundle without failures`, c.failed === 0 && c.applied >= 1],
  ["new build received the old release's memory", c.oldMemory],
  ["old release's edit arrived", c.editedContent === "compat: written by the new build, edited on the old release"],
  ["metadata survived the old release's edit", c.gitBranch === "feat/compat" && c.memoryClass === "durable"],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  ok &&= pass;
}
process.exit(ok ? 0 : 1);
