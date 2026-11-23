#!/usr/bin/env node
/* Context-cost audit: how many tokens Memoria actually hands to an agent.
 *
 * Works on a COPY of a database (read through SQLite's immutable mode, then
 * `.backup` into a temp dir), so the source is never opened for writing and
 * no project file is touched (the resume block is generated, not injected).
 *
 *   node scripts/audit-context.mjs [path/to/memory.db]   (default ~/.memoria/memory.db)
 *
 * Tokens are estimated as characters / 4, the same estimate the dashboard uses.
 * Needs `npm run build` and the sqlite3 CLI.
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[2] || path.join(os.homedir(), ".memoria", "memory.db"));
if (!fs.existsSync(source)) {
  console.error(`No database at ${source}`);
  process.exit(1);
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-audit-"));
const dataDir = path.join(work, "data");
const home = path.join(work, "home");
fs.mkdirSync(dataDir);
fs.mkdirSync(home);
const copy = path.join(dataDir, "memory.db");
execFileSync("sqlite3", [`file:${source}?mode=ro&immutable=1`, `.backup ${copy}`]);
process.env.MEMORIA_DATA_DIR = dataDir;
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(path.join(root, "package.json"));
const db = require("./dist/engine/store/db.js");
db.initDb(dataDir);
const { generateHandoff } = require("./dist/engine/handoff.js");
const { sessionStartContext } = require("./dist/engine/hooks/claude.js");

const tok = (s) => Math.round(String(s || "").length / 4);
const summary = (vals) => {
  const v = vals.slice().sort((a, b) => a - b);
  if (!v.length) return "n=0";
  return `median ${v[Math.floor(v.length / 2)]}, p90 ${v[Math.max(0, Math.ceil(v.length * 0.9) - 1)]}, max ${v[v.length - 1]} (n=${v.length})`;
};
const projects = db
  .getDb()
  .prepare(
    `SELECT p.slug, p.path FROM projects p
     JOIN memories m ON m.project_id = p.id AND m.archived = 0 AND m.status = 'active'
     GROUP BY p.id HAVING COUNT(m.id) >= 3 ORDER BY COUNT(m.id) DESC`
  )
  .all();

const block = [];
const hook = [];
const dup = [];
for (const p of projects) {
  const slim = await generateHandoff(p.slug, { slim: true });
  block.push(tok(slim));
  if (!p.path) continue;
  const h = await sessionStartContext(p.path);
  hook.push(tok(h));
  // Duplicate = hook lines Claude Code already gets from the CLAUDE.md on disk.
  let onDisk = "";
  try {
    onDisk = fs.readFileSync(path.join(p.path, "CLAUDE.md"), "utf8");
  } catch {
    continue;
  }
  if (!onDisk.includes("memoria:start")) continue;
  const inFile = new Set(onDisk.split("\n").map((l) => l.trim()).filter((l) => l.length > 8));
  dup.push(tok(h.split("\n").map((l) => l.trim()).filter((l) => l.length > 8 && inFile.has(l)).join("\n")));
}

// MCP tool responses through the real stdio server.
const child = spawn(process.execPath, [path.join(root, "dist/engine/index.js"), "mcp"], {
  env: { ...process.env },
  stdio: ["pipe", "pipe", "ignore"],
});
let buf = "";
let id = 0;
const waiting = new Map();
child.stdout.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    } catch {
      /* not JSON-RPC */
    }
  }
});
const rpc = (method, params) =>
  new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "audit", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const text = (m) => (m.result?.content || []).map((c) => c.text || "").join("");
const tools = {};
const add = (k, v) => (tools[k] = tools[k] || []).push(v);
let emptyRecalls = 0;
let recalls = 0;
for (const p of projects.filter((x) => x.path).slice(0, 8)) {
  for (const mode of ["index", "full"]) add(`project_context (${mode})`, tok(text(await rpc("tools/call", { name: "project_context", arguments: { project: p.path, mode } }))));
  add("build_context", tok(text(await rpc("tools/call", { name: "build_context", arguments: { project: p.path } }))));
  for (const q of ["error", "deploy", "database", "build"]) {
    const t = text(await rpc("tools/call", { name: "recall", arguments: { query: q, project: p.path } }));
    recalls++;
    if (/^No matching memories/.test(t)) emptyRecalls++;
    else add("recall (full, hits only)", tok(t));
  }
}
child.kill();

console.log(`Context-cost audit — ${projects.length} projects with ≥3 active memories (tokens ≈ chars/4)\n`);
console.log(`Resume block written to AGENTS.md / CLAUDE.md / GEMINI.md   ${summary(block)}`);
console.log(`Claude Code SessionStart hook                               ${summary(hook)}`);
console.log(`  duplicated from CLAUDE.md (projects with a Memoria block) ${summary(dup)}`);
for (const [k, v] of Object.entries(tools)) console.log(`MCP ${k.padEnd(56)} ${summary(v)}`);
console.log(`Project-scoped recall with no hit                           ${emptyRecalls}/${recalls}`);
fs.rmSync(work, { recursive: true, force: true });
