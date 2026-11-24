/* Memory lifecycle (quality phase Q5).
 *
 * - `working` memories (turn reports, todos, short approvals, "still
 *   failing" tasks) carry `expires_at`. Once it has passed they are archived,
 *   as one triage batch per run (`maintain triage --undo` restores them).
 *   Retiring runs before context is served, so an expired memory is never
 *   handed to an agent even between housekeeping runs.
 * - A memory that names project files, none of which exist any more, is
 *   "stale": it still shows up, ranked lower and marked, because the fact
 *   may have moved rather than become false.
 * Durable memories keep the existing forgetting curve (archiveStaleEligibles). */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { archiveMemory, getDb, setSetting } from "../store/db";

let lastRun = 0;

/** Archive expired working memories. Cheap when nothing is due (indexed). */
export function retireExpired(now = Date.now(), opts: { minIntervalMs?: number } = {}): number {
  if (opts.minIntervalMs && now - lastRun < opts.minIntervalMs) return 0;
  lastRun = now;
  const d = getDb();
  let due: Array<{ id: number; status: string; importance: number }>;
  try {
    due = d
      .prepare(
        `SELECT id, status, importance FROM memories
         WHERE expires_at > 0 AND expires_at <= ? AND archived = 0 AND memory_class = 'working'`
      )
      .all(now) as Array<{ id: number; status: string; importance: number }>;
  } catch {
    return 0; // before migration v13
  }
  if (!due.length) return 0;
  const batch = `expire-${now}-${randomUUID().slice(0, 8)}`;
  const log = d.prepare(
    "INSERT INTO triage_log (batch, memory_id, action, reason, prev_status, prev_archived, prev_importance, ts) VALUES (?, ?, 'archive', 'expired', ?, 0, ?, ?)"
  );
  d.exec("BEGIN");
  try {
    for (const m of due) {
      archiveMemory(m.id, true);
      log.run(batch, m.id, m.status, m.importance, now);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  setSetting("lastTriageBatch", batch);
  return due.length;
}

/** Relative project paths named in a memory (`src/a.ts`, `app/page.tsx`). */
const REL_PATH = /(?:^|[\s`'"(])((?:\.\/)?[\w@.-]+(?:\/[\w@.[\]-]+)+\.[A-Za-z0-9]{1,8})(?=$|[\s`'"),.:;])/g;

export function mentionedPaths(content: string): string[] {
  const out = new Set<string>();
  for (const m of String(content || "").matchAll(REL_PATH)) {
    const p = m[1].replace(/^\.\//, "");
    if (p.startsWith("http") || p.includes("..")) continue;
    out.add(p);
  }
  return [...out].slice(0, 8);
}

const existsCache = new Map<string, { at: number; ok: boolean }>();

/** True when the memory names project files and none of them exists under
 * `root` any more (also checked one directory up and down, since agents
 * often name paths relative to a sub-package). Unknown root → false. */
export function isStale(content: string, root: string | null | undefined): boolean {
  if (!root) return false;
  const paths = mentionedPaths(content);
  if (!paths.length) return false;
  const now = Date.now();
  const exists = (p: string): boolean => {
    const key = `${root}\u0000${p}`;
    const c = existsCache.get(key);
    if (c && now - c.at < 60_000) return c.ok;
    let ok = false;
    try {
      ok = fs.existsSync(path.join(root, p)) || fs.existsSync(path.join(path.dirname(root), p));
      if (!ok) {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && fs.existsSync(path.join(root, e.name, p))) {
            ok = true;
            break;
          }
        }
      }
    } catch {
      ok = true; // unreadable root: do not call anything stale
    }
    if (existsCache.size > 5000) existsCache.clear();
    existsCache.set(key, { at: now, ok });
    return ok;
  };
  if (!fs.existsSync(root)) return false; // project folder not on this machine
  return !paths.some(exists);
}
