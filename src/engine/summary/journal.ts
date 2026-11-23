/* ---------- Learning journal ----------
 * What did this week's errors teach you? Built from `error_fixed` memories
 * only, with no model: fixes in the window are grouped by text similarity,
 * a group is "recurring" when the same error was already fixed before the
 * window, and file paths mentioned in fixes are counted so the files that keep
 * breaking stand out.
 * ------------------------------------------------------------------------- */
import { readMemories, projectSlugById } from "../store/db";
import { textSimilarity } from "../extract/dedupe";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Jaccard over tokens; fixes of the same error share their key terms. */
const SAME_ERROR = 0.35;
/** How far back a fix counts as "seen before". */
const HISTORY_DAYS = 90;
const FILE_RE = /(?:^|[\s(`'"])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|vue|svelte|css|scss|html|json|ya?ml|toml|sql|sh|md))(?=$|[\s):,`'"])/g;

export interface JournalEntry {
  /** Most recent fix in the group. */
  id: number;
  content: string;
  project: string;
  createdAt: number;
  /** Fixes of this error inside the window. */
  timesThisWeek: number;
  /** Fixes of the same error in the HISTORY_DAYS before the window. */
  timesBefore: number;
  recurring: boolean;
  files: string[];
}
export interface LearningJournal {
  since: number;
  until: number;
  days: number;
  fixes: number;
  /** Fixed errors in the period of the same length right before this one. */
  previousFixes: number;
  entries: JournalEntry[];
  recurring: JournalEntry[];
  topFiles: Array<{ file: string; count: number }>;
  perProject: Array<{ project: string; count: number }>;
  markdown: string;
}

function filesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FILE_RE)) out.add(m[1]);
  return [...out];
}
function oneLine(s: string, max = 220): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function learningJournal(opts: { days?: number; now?: number; project?: number | null } = {}): LearningJournal {
  const days = Math.max(1, Math.min(90, Math.floor(opts.days ?? 7)));
  const until = opts.now ?? Date.now();
  const since = until - days * DAY_MS;
  const histFrom = since - HISTORY_DAYS * DAY_MS;
  const where = ["kind = 'error_fixed'", "archived = 0", "status = 'active'", "created_at >= ?", "created_at <= ?"];
  const params: Array<number> = [histFrom, until];
  if (opts.project != null) {
    where.push("project_id = ?");
    params.push(opts.project);
  }
  const all = readMemories(`WHERE ${where.join(" AND ")} ORDER BY created_at DESC`, params);
  const inWindow = all.filter((m) => (m.createdAt || 0) >= since);
  const before = all.filter((m) => (m.createdAt || 0) < since);
  const previousFixes = before.filter((m) => (m.createdAt || 0) >= since - days * DAY_MS).length;

  // Greedy grouping, newest first: each fix joins the first group it resembles.
  const groups: Array<typeof inWindow> = [];
  for (const m of inWindow) {
    const g = groups.find((grp) => grp.some((x) => x.projectId === m.projectId && textSimilarity(x.content, m.content) >= SAME_ERROR));
    if (g) g.push(m);
    else groups.push([m]);
  }

  const fileCount = new Map<string, number>();
  const projCount = new Map<string, number>();
  const entries: JournalEntry[] = groups.map((g) => {
    const head = g[0];
    const project = projectSlugById(head.projectId) || "global";
    const timesBefore = before.filter((b) => b.projectId === head.projectId && g.some((x) => textSimilarity(x.content, b.content) >= SAME_ERROR)).length;
    const files = [...new Set(g.flatMap((x) => filesIn(x.content)))];
    for (const f of files) fileCount.set(f, (fileCount.get(f) || 0) + 1);
    projCount.set(project, (projCount.get(project) || 0) + g.length);
    return {
      id: head.id!,
      content: oneLine(head.content),
      project,
      createdAt: head.createdAt || 0,
      timesThisWeek: g.length,
      timesBefore,
      recurring: timesBefore > 0 || g.length > 1,
      files,
    };
  });
  // Recurring first, then by how often, then newest.
  entries.sort((a, b) => Number(b.recurring) - Number(a.recurring) || b.timesThisWeek + b.timesBefore - (a.timesThisWeek + a.timesBefore) || b.createdAt - a.createdAt);
  const recurring = entries.filter((e) => e.recurring);
  const topFiles = [...fileCount.entries()].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([file, count]) => ({ file, count }));
  const perProject = [...projCount.entries()].sort((a, b) => b[1] - a[1]).map(([project, count]) => ({ project, count }));

  const lines: string[] = [];
  lines.push(`## Learning journal (last ${days} days)`);
  lines.push("");
  if (!entries.length) {
    lines.push("No fixed errors recorded in this period.");
  } else {
    lines.push(`${inWindow.length} fixed error${inWindow.length === 1 ? "" : "s"}, ${entries.length} distinct, ${recurring.length} recurring.`);
    if (recurring.length) {
      lines.push("");
      lines.push("### Recurring: worth a permanent fix or a note");
      for (const e of recurring.slice(0, 8)) {
        const n = e.timesThisWeek + e.timesBefore;
        lines.push(`- ${e.content} _(${e.project}, fixed ${n}×${e.timesBefore ? `, ${e.timesBefore} before this period` : ""})_`);
      }
    }
    const fresh = entries.filter((e) => !e.recurring);
    if (fresh.length) {
      lines.push("");
      lines.push("### New this period");
      for (const e of fresh.slice(0, 10)) lines.push(`- ${e.content} _(${e.project})_`);
    }
    if (topFiles.length) {
      lines.push("");
      lines.push("### Files that keep breaking");
      for (const f of topFiles) lines.push(`- \`${f.file}\`: ${f.count} fixes`);
    }
  }
  return { since, until, days, fixes: inWindow.length, previousFixes, entries, recurring, topFiles, perProject, markdown: lines.join("\n") };
}
