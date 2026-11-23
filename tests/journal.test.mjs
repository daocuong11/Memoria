/* Learning journal: weekly error→fix summary, recurring fixes first. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);
// Isolate everything that resolves the data dir from config (the digest file).
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-journal-"));
process.env.MEMORIA_DATA_DIR = DATA;
const dbmod = require("../dist/engine/store/db.js");
const { learningJournal } = require("../dist/engine/summary/journal.js");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 20, 12);
dbmod.closeDb();
dbmod.initDb(DATA);
const pid = dbmod.ensureProject("shop", "/tmp/shop");
const other = dbmod.ensureProject("blog", "/tmp/blog");
const fix = (content, daysAgo, over = {}) =>
  dbmod.insertMemory({ projectId: pid, kind: "error_fixed", content, importance: 0.6, createdAt: NOW - daysAgo * DAY, lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic", ...over });

// Recurring: fixed 30 days ago and again this week.
fix("ECONNREFUSED on npm start: DATABASE_URL missing in .env.local, fixed by adding it", 30);
fix("ECONNREFUSED on npm start again: DATABASE_URL was missing from .env.local", 2);
// Twice inside the week, same file.
fix("TypeError in src/cart/total.ts: price undefined for free items, default to 0", 3);
fix("TypeError in src/cart/total.ts when price is undefined on free items", 1);
// One-off.
fix("Vite build failed: wrong import path in src/pages/checkout.tsx", 4);
// Out of scope: other kinds, archived, drafts, older than the window only.
fix("Hydration warning fixed by moving Date.now() into useEffect", 20);
fix("Draft fix that should not count", 1, { status: "draft" });
dbmod.insertMemory({ projectId: pid, kind: "decision", content: "Use Postgres", importance: 0.6, createdAt: NOW - DAY, lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic" });
// Same wording in another project is a different error.
fix("ECONNREFUSED on npm start: DATABASE_URL missing in .env.local", 1, { projectId: other });

test("groups fixes, flags recurring ones first, counts history", () => {
  const j = learningJournal({ days: 7, now: NOW });
  assert.equal(j.fixes, 5, "4 shop fixes + 1 blog fix in the window");
  assert.equal(j.previousFixes, 0, "nothing in the 7 days before the window");
  assert.equal(j.entries.length, 4, "the two cart fixes are one error");
  const env = j.entries.find((e) => e.project === "shop" && /DATABASE_URL/.test(e.content));
  assert.ok(env.recurring);
  assert.equal(env.timesBefore, 1);
  const cart = j.entries.find((e) => /total\.ts/.test(e.content));
  assert.equal(cart.timesThisWeek, 2);
  assert.ok(cart.recurring);
  assert.deepEqual(cart.files, ["src/cart/total.ts"]);
  const blog = j.entries.find((e) => e.project === "blog");
  assert.equal(blog.recurring, false, "history is per project");
  assert.ok(j.entries.slice(0, 2).every((e) => e.recurring), "recurring entries come first");
  assert.deepEqual(j.topFiles, [], "a file needs fixes in two distinct errors to be listed");
  assert.match(j.markdown, /### Recurring/);
  assert.match(j.markdown, /### New this period/);
  assert.ok(!/Draft fix/.test(j.markdown));
  assert.ok(!/Hydration/.test(j.markdown), "older fixes only count as history");
});

test("project filter and empty period", () => {
  assert.equal(learningJournal({ days: 7, now: NOW, project: other }).entries.length, 1);
  const empty = learningJournal({ days: 7, now: NOW + 365 * DAY });
  assert.equal(empty.entries.length, 0);
  assert.match(empty.markdown, /No fixed errors/);
});

test("weekly digest includes the journal section", () => {
  const { generateWeeklyDigest } = require("../dist/engine/summary/weekly.js");
  const d = generateWeeklyDigest();
  assert.match(d.text, /## Learning journal \(last 7 days\)/);
  assert.equal(path.dirname(d.path), DATA, "digest file stays in the temp data dir");
});
