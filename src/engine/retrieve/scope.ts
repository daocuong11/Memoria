/* ---------- Project scope = git repository ----------
 * Tools report the directory a session was opened in, so one repository
 * often turns into several projects: `repo`, `repo/contracts`,
 * `repo/services/api`. Scoped recall used to see only the exact project and
 * missed what was learned one folder up or down. A project's scope is now
 * every project inside the same git work tree. Folders outside git (a
 * workspace holding many unrelated repos) keep the exact-project scope, so
 * unrelated projects never leak into each other.
 * ------------------------------------------------------------------------- */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDb } from "../store/db";

const TTL_MS = 10 * 60 * 1000;
const toplevelCache = new Map<string, { root: string | null; at: number }>();

/** Git work-tree root of a directory, or null (not a repo, missing, no git). */
export function gitToplevel(dir: string | null | undefined): string | null {
  if (!dir) return null;
  const hit = toplevelCache.get(dir);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.root;
  let root: string | null = null;
  try {
    if (fs.existsSync(dir)) {
      root = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim() || null;
      if (root) root = path.resolve(root);
    }
  } catch {
    root = null;
  }
  if (toplevelCache.size > 2000) toplevelCache.clear();
  toplevelCache.set(dir, { root, at: Date.now() });
  return root;
}

const scopeCache = new Map<number, { ids: Set<number>; at: number }>();

/** Ids of every project in the same git work tree as `projectId` (always
 * including the project itself). */
export function projectScopeIds(projectId: number | null | undefined): Set<number> {
  if (projectId == null) return new Set();
  const hit = scopeCache.get(projectId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ids;
  const ids = new Set<number>([projectId]);
  const d = getDb();
  const self = d.prepare("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string | null } | undefined;
  const root = gitToplevel(self?.path);
  if (root) {
    const rows = d
      .prepare("SELECT id, path FROM projects WHERE path IS NOT NULL AND path != '' AND id != ?")
      .all(projectId) as Array<{ id: number; path: string }>;
    for (const r of rows) {
      const p = path.resolve(r.path);
      // Cheap prefix test first; only candidates under the root pay a git call
      // (a nested repo inside the root is its own work tree).
      if (p !== root && !p.startsWith(root + path.sep)) continue;
      if (gitToplevel(r.path) === root) ids.add(r.id);
    }
  }
  if (scopeCache.size > 2000) scopeCache.clear();
  scopeCache.set(projectId, { ids, at: Date.now() });
  return ids;
}

/** Test hook: forget cached git roots and scopes. */
export function resetScopeCache(): void {
  toplevelCache.clear();
  scopeCache.clear();
}
