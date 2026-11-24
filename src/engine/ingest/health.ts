/* Capture health per tool (quality phase Q8).
 *
 * "Is Memoria actually capturing my sessions?" used to be invisible: a parser
 * that stopped matching a new on-disk format, or a source path that moved,
 * just produced nothing. Each scan now records its outcome per tool, and the
 * report compares the newest source file with the newest stored message:
 * if the tool kept writing but Memoria stopped storing, the tool is "behind". */
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "../config";
import { getBoolSetting, getDb, getSetting, setSetting } from "../store/db";

const DAY = 86_400_000;
/** Source newer than the last stored message by more than this = behind. */
const BEHIND_MS = DAY;

export interface ScanOutcome {
  ok: boolean;
  detail: string;
  count: number;
  ms: number;
  /** Files (or rows) the parser could not read; the rest of the scan went on. */
  fileErrors?: number;
}

export type HealthStatus = "ok" | "behind" | "error" | "idle" | "missing" | "disabled";

export interface ToolHealth {
  tool: string;
  label: string;
  status: HealthStatus;
  reason: string;
  sourceFound: boolean;
  sourceUpdatedAt: number;
  lastStoredAt: number;
  stored7d: number;
  events7d: number;
  lastScanAt: number;
  lastScanOk: boolean | null;
  lastScanDetail: string;
  fileErrors: number;
}

export function recordScan(tool: string, o: ScanOutcome): void {
  try {
    setSetting(`captureHealth:${tool}`, JSON.stringify({ at: Date.now(), ...o, detail: o.detail.slice(0, 300) }));
  } catch {
    /* health is best effort */
  }
}

/** Which files count as "the tool wrote a session" per tool. Without this,
 * config files, IDE state databases and other tools' data sharing a folder
 * (~/.gemini also holds Antigravity) made a tool look "behind". */
const SESSION_FILES: Record<string, { file: RegExp; skip?: RegExp }> = {
  claude: { file: /\.jsonl$/ },
  codex: { file: /\.jsonl$/ },
  gemini: { file: /\.jsonl?$/, skip: /antigravity|[\\/](?:config|bin|logs|node_modules)(?:[\\/]|$)/ },
  opencode: { file: /opencode\.db$/ },
  copilot: { file: /session-store\.db$/ },
  antigravity: { file: /\.(?:jsonl?|md|pb|log)$/ },
  vscode: { file: /chatSessions[\\/][^\\/]+\.jsonl?$/ },
  cursor: { file: /chatSessions[\\/][^\\/]+\.jsonl?$|state\.vscdb$/ },
  windsurf: { file: /chatSessions[\\/][^\\/]+\.jsonl?$|state\.vscdb$/ },
};

/** Newest mtime of session files under a path (a few levels deep, capped). */
export function newestMtime(p: string, depth = 5, budget = { n: 20000 }, filter: { file: RegExp; skip?: RegExp } = { file: /\.(jsonl|json|db|vscdb|md)$/ }): number {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return filter.file.test(p) ? st.mtimeMs : 0;
  let best = 0;
  if (depth <= 0) return 0;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return st.mtimeMs;
  }
  for (const e of entries) {
    if (--budget.n <= 0) break;
    if (e.name === "node_modules" || e.name.startsWith(".git")) continue;
    const full = path.join(p, e.name);
    if (filter.skip?.test(full)) continue;
    const m = e.isDirectory() ? newestMtime(full, depth - 1, budget, filter) : e.isFile() && filter.file.test(full) ? safeMtime(full) : 0;
    if (m > best) best = m;
  }
  return best;
}

function safeMtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

export function captureHealth(now = Date.now()): ToolHealth[] {
  const d = getDb();
  const out: ToolHealth[] = [];
  for (const src of getConfig().sources) {
    const enabled = getBoolSetting(`source:${src.tool}:enabled`, src.enabled);
    const found = src.paths.some((p) => fs.existsSync(p));
    const filter = SESSION_FILES[src.tool];
    const sourceUpdatedAt = found ? Math.max(...src.paths.map((p) => newestMtime(p, 5, { n: 20000 }, filter))) : 0;
    const t = d
      .prepare("SELECT MAX(ts) AS last, SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS week FROM transcripts WHERE tool = ?")
      .get(now - 7 * DAY, src.tool) as { last: number | null; week: number | null };
    let events7d = 0;
    try {
      events7d = (d.prepare("SELECT COUNT(*) AS c FROM session_events WHERE tool = ? AND ts >= ?").get(src.tool, now - 7 * DAY) as { c: number }).c;
    } catch {
      /* before migration v13 */
    }
    let scan: { at?: number; ok?: boolean; detail?: string; fileErrors?: number } = {};
    try {
      scan = JSON.parse(getSetting(`captureHealth:${src.tool}`, "{}") || "{}");
    } catch {
      scan = {};
    }
    const lastStoredAt = t.last || 0;
    let status: HealthStatus;
    let reason: string;
    if (!enabled) {
      status = "disabled";
      reason = "turned off in settings";
    } else if (!found) {
      status = "missing";
      reason = `no data at ${src.paths[0]}`;
    } else if (scan.ok === false) {
      status = "error";
      reason = `last scan failed: ${scan.detail || "unknown error"}`;
    } else if (!lastStoredAt) {
      // Nothing stored: either no session was ever held in this tool (empty
      // chat files are common) or the parser does not understand them.
      status = "idle";
      reason = sourceUpdatedAt
        ? "session files found but nothing stored yet: run `memoria scan`; if it stays empty, the files hold no messages or their format is not understood"
        : "no session files yet";
    } else if (sourceUpdatedAt - lastStoredAt > BEHIND_MS) {
      status = "behind";
      reason = `the tool wrote sessions ${Math.round((sourceUpdatedAt - lastStoredAt) / DAY)} day(s) after the last stored message`;
    } else {
      status = "ok";
      reason = (scan.fileErrors || 0) > 0 ? `${scan.fileErrors} file(s) could not be read` : "";
    }
    out.push({
      tool: src.tool,
      label: src.label,
      status,
      reason,
      sourceFound: found,
      sourceUpdatedAt,
      lastStoredAt,
      stored7d: t.week || 0,
      events7d,
      lastScanAt: scan.at || 0,
      lastScanOk: typeof scan.ok === "boolean" ? scan.ok : null,
      lastScanDetail: scan.detail || "",
      fileErrors: scan.fileErrors || 0,
    });
  }
  return out;
}
