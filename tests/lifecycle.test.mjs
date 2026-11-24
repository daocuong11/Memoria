/* Q5 lifecycle: expired working memories are retired before serving (one
 * undoable batch), durable ones are untouched, and memories naming files that
 * are gone are marked stale and ranked lower. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-life-"));
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
const { retireExpired, isStale, mentionedPaths } = require("../dist/engine/extract/expire.js");
const { projectContext, searchMemories } = require("../dist/engine/retrieve/search.js");
const { undoTriage } = require("../dist/engine/extract/triage.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-life-proj-"));
fs.mkdirSync(path.join(root, "src"), { recursive: true });
fs.writeFileSync(path.join(root, "src", "live.ts"), "export {};\n");
const pid = dbmod.ensureProject("life-proj", root);
const slug = dbmod.projectSlugById(pid);
const now = Date.now();
const add = (content, over = {}) =>
  dbmod.insertMemory({ projectId: pid, kind: "fact", content, importance: 0.6, createdAt: now - 1000, sourceTool: "claude", status: "active", origin: "heuristic", ...over });

test("mentionedPaths / isStale", () => {
  assert.deepEqual(mentionedPaths("Fixed in `src/live.ts` and ./src/gone.ts, see https://x.y/a.ts"), ["src/live.ts", "src/gone.ts"]);
  assert.equal(isStale("The parser lives in src/gone.ts", root), true);
  assert.equal(isStale("The parser lives in src/live.ts and src/gone.ts", root), false, "one existing file is enough");
  assert.equal(isStale("No file named here", root), false);
  assert.equal(isStale("src/gone.ts", "/definitely/not/on/this/machine"), false, "unknown folder: not stale");
});

test("retireExpired: only expired working memories, one undoable batch", () => {
  const expired = add("Turn report: build fixed, deploy pending", { kind: "context", memoryClass: "working", expiresAt: now - 1 });
  const future = add("Turn report: still working on the importer", { kind: "context", memoryClass: "working", expiresAt: now + 86_400_000 });
  const durable = add("Durable decision with an old expiry field", { kind: "decision", memoryClass: "durable", expiresAt: now - 1 });
  assert.equal(retireExpired(now), 1);
  const arch = (id) => dbmod.getDb().prepare("SELECT archived FROM memories WHERE id = ?").get(id).archived;
  assert.equal(arch(expired), 1);
  assert.equal(arch(future), 0);
  assert.equal(arch(durable), 0, "only working memories expire");
  assert.ok(!projectContext(slug, 20).some((h) => h.id === expired), "not served");
  assert.equal(retireExpired(now), 0, "idempotent");
  assert.equal(undoTriage().restored, 1);
  assert.equal(arch(expired), 0, "undo restores it");
  retireExpired(now);
});

test("search: expired memories retired on the way in; stale memories marked and ranked lower", () => {
  const gone = add("Payment webhook verification lives in src/gone.ts with HMAC");
  const live = add("Payment webhook verification lives in src/live.ts with HMAC");
  const late = add("Payment webhook retry note for the old handler", { kind: "context", memoryClass: "working", expiresAt: now - 5 });
  const hits = searchMemories("payment webhook verification HMAC", { limit: 10, projectSlug: slug });
  const byId = new Map(hits.map((h) => [h.id, h]));
  assert.equal(byId.get(gone).stale, true);
  assert.ok(!byId.get(live).stale);
  assert.ok(hits.findIndex((h) => h.id === live) < hits.findIndex((h) => h.id === gone), "stale ranks below the same fact that is current");
  assert.ok(!byId.has(late), "expired working memory is not returned");
  const ctx = projectContext(slug, 20);
  assert.equal(ctx.find((h) => h.id === gone).stale, true);
});
