/* ---------- File context ----------
 * "What do we know about this file?" — active memories that mention a file
 * path: fixed errors, decisions, open tasks. Lets an agent ask before it edits
 * a file instead of rediscovering an old bug.
 *
 * Matching works on path segments from the end. A memory that mentions
 * `src/engine/http.ts` matches a query for `/abs/repo/src/engine/http.ts`,
 * `engine/http.ts`, or `http.ts`. Generic file names (index.ts, page.tsx, …)
 * need at least two matching segments, otherwise every project would match.
 * ------------------------------------------------------------------------- */
import { getDb, resolveProject } from "../store/db";
import { projectScopeIds } from "./scope";

export interface FileContextHit {
  id: number;
  kind: string;
  content: string;
  importance: number;
  createdAt: number;
  projectId: number | null;
  /** Number of trailing path segments that matched (higher = more specific). */
  matched: number;
}

const GENERIC_BASENAMES = new Set([
  "index", "main", "app", "page", "layout", "route", "routes", "utils", "util", "helpers",
  "config", "types", "constants", "server", "client", "styles", "globals", "readme", "package",
  "mod", "lib", "init", "__init__", "setup", "test", "spec", "schema", "model", "models",
]);

const KIND_ORDER: Record<string, number> = { error_fixed: 0, decision: 1, task_pending: 2, preference: 3, fact: 4, task_done: 5, context: 6 };

function segments(p: string): string[] {
  return p.replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..");
}

/** Number of trailing segments of `query` found as a contiguous path in `text`. */
function trailingMatch(text: string, query: string[]): number {
  const hay = text.replace(/\\/g, "/");
  let best = 0;
  for (let n = 1; n <= Math.min(query.length, 6); n++) {
    const tail = query.slice(-n).join("/");
    // Boundary on both sides so `http.ts` does not match `myhttp.tsx`.
    const re = new RegExp(`(^|[^\\w.-])${tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`);
    if (re.test(hay)) best = n;
    else break;
  }
  return best;
}

export function fileContext(filePath: string, opts: { project?: string; limit?: number } = {}): FileContextHit[] {
  const segs = segments(filePath);
  if (!segs.length) return [];
  const base = segs[segs.length - 1];
  const stem = base.replace(/\.[^.]+$/, "").toLowerCase();
  // Generic names (page.tsx, index.ts) exist in almost every project: with a
  // folder they need two matching segments; a bare name needs a project scope.
  const generic = GENERIC_BASENAMES.has(stem);
  if (generic && segs.length === 1 && !opts.project) return [];
  const minSegs = generic && segs.length > 1 ? 2 : 1;
  const where = ["archived = 0", "status = 'active'", "content LIKE ? ESCAPE '\\'"];
  const params: Array<string | number> = [`%${base.replace(/[\\%_]/g, (c) => "\\" + c)}%`];
  if (opts.project) {
    const proj = resolveProject(opts.project);
    if (proj) {
      const ids = [...projectScopeIds(proj.id)];
      where.push(`project_id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
  }
  const rows = getDb()
    .prepare(
      `SELECT id, kind, content, importance, created_at, project_id FROM memories
       WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 400`
    )
    .all(...params) as Array<{ id: number; kind: string; content: string; importance: number; created_at: number; project_id: number | null }>;
  const hits: FileContextHit[] = [];
  for (const r of rows) {
    const matched = trailingMatch(r.content, segs);
    if (matched < minSegs) continue;
    hits.push({ id: r.id, kind: r.kind, content: r.content, importance: r.importance, createdAt: r.created_at, projectId: r.project_id, matched });
  }
  hits.sort(
    (a, b) =>
      b.matched - a.matched ||
      (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) ||
      b.importance - a.importance ||
      b.createdAt - a.createdAt
  );
  return hits.slice(0, opts.limit ?? 12);
}
