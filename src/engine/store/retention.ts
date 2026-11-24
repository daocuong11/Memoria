/* Transcript retention (quality phase Q6).
 *
 * Raw transcripts are only needed until they are extracted and the session
 * is over. Old ones can be moved out of the database:
 * - default: ARCHIVE to a gzip JSONL file under <dataDir>/archive/ (local,
 *   restorable with `restoreTranscripts`);
 * - opt-in: DELETE permanently.
 * Never touched: rows not yet extracted, and the latest session of every
 * project (the resume block reads it). Memories and session events stay. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { getConfig } from "../config";
import { getDb } from "./db";

const DAY = 86_400_000;

export interface RetentionPlan {
  cutoff: number;
  rows: number;
  sessions: number;
  bytes: number;
}

export interface RetentionResult extends RetentionPlan {
  mode: "archive" | "delete";
  file: string | null;
}

type Row = { id: number; tool: string; session_id: string; project_id: number | null; role: string; content: string; ts: number; seq: number; extracted: number };

/** Rows that may go: older than the cutoff, extracted, and not part of the
 * latest session of their project. */
function candidates(cutoff: number): Row[] {
  const d = getDb();
  const latest = new Set(
    (d
      .prepare(
        `SELECT t.project_id AS p, t.tool AS tool, t.session_id AS s FROM transcripts t
         JOIN (SELECT project_id, MAX(ts) AS m FROM transcripts GROUP BY project_id) x
           ON x.project_id IS t.project_id AND x.m = t.ts`
      )
      .all() as Array<{ p: number | null; tool: string; s: string }>).map((r) => `${r.p}\u0000${r.tool}\u0000${r.s}`)
  );
  return (d
    .prepare("SELECT id, tool, session_id, project_id, role, content, ts, seq, extracted FROM transcripts WHERE ts < ? AND extracted = 1 ORDER BY id")
    .all(cutoff) as Row[]).filter((r) => !latest.has(`${r.project_id}\u0000${r.tool}\u0000${r.session_id}`));
}

export function planRetention(days: number, now = Date.now()): RetentionPlan {
  const cutoff = now - Math.max(1, days) * DAY;
  const rows = candidates(cutoff);
  return {
    cutoff,
    rows: rows.length,
    sessions: new Set(rows.map((r) => `${r.tool}:${r.session_id}`)).size,
    bytes: rows.reduce((a, r) => a + (r.content?.length || 0), 0),
  };
}

function archiveDir(): string {
  const dir = path.join(getConfig().dataDir, "archive");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Apply retention. The archive file is written and flushed before any row
 * is deleted; on a write error nothing is deleted. */
export function applyRetention(days: number, opts: { mode?: "archive" | "delete"; now?: number } = {}): RetentionResult {
  const mode = opts.mode ?? "archive";
  const plan = planRetention(days, opts.now);
  if (!plan.rows) return { ...plan, mode, file: null };
  const d = getDb();
  const rows = candidates(plan.cutoff);
  let file: string | null = null;
  if (mode === "archive") {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    file = path.join(archiveDir(), `transcripts-${stamp}.jsonl.gz`);
    const body = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const gz = zlib.gzipSync(Buffer.from(body, "utf8"), { level: 9 });
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeSync(fd, gz);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Read back before deleting anything.
    const check = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").trimEnd().split("\n").length;
    if (check !== rows.length) throw new Error(`archive check failed: ${check} of ${rows.length} rows`);
  }
  const del = d.prepare("DELETE FROM transcripts WHERE id = ?");
  d.exec("BEGIN");
  try {
    for (const r of rows) del.run(r.id);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return { ...plan, mode, file };
}

/** Put archived rows back (rows already present are skipped). */
export function restoreTranscripts(file: string): number {
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8").split("\n").filter(Boolean);
  const d = getDb();
  const ins = d.prepare(
    "INSERT OR IGNORE INTO transcripts (tool, session_id, project_id, role, content, ts, seq, extracted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  let n = 0;
  d.exec("BEGIN");
  try {
    for (const l of lines) {
      const r = JSON.parse(l);
      n += Number(ins.run(r.tool, r.session_id, r.project_id, r.role, r.content, r.ts, r.seq, r.extracted ?? 1).changes);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return n;
}
