/* Retrieval inspector (quality phase Q1.5): a local record of what each
 * context tool handed an agent, so a person can see why a memory showed up
 * and mark it "not relevant". The log holds at most LOG_CAP rows, queries are
 * redacted before they are stored, and none of it is synced. Marks are kept
 * after their log row is pruned; they are input for the evidence score. */
import { getBoolSetting, getDb, projectSlugById } from "../store/db";
import { redactSecrets } from "../privacy/redact";

export const LOG_CAP = 500;
const QUERY_MAX = 300;

export interface LoggedHit {
  id: number;
  score?: number;
}

export interface RetrievalEntry {
  id: number;
  ts: number;
  source: string;
  project: string | null;
  query: string;
  servedChars: number;
  hits: Array<{
    id: number;
    score: number | null;
    kind: string | null;
    content: string | null;
    archived: boolean;
    irrelevant: boolean;
  }>;
}

export function retrievalLogEnabled(): boolean {
  return getBoolSetting("retrievalLog", true);
}

/** Never throws: logging must not break a tool call. */
export function logRetrieval(source: string, projectId: number | null, query: string, hits: LoggedHit[], servedChars: number): number | null {
  if (!retrievalLogEnabled()) return null;
  try {
    const d = getDb();
    const q = redactSecrets(String(query || "").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX)).text;
    const compact = hits.slice(0, 30).map((h) => (h.score === undefined ? { id: h.id } : { id: h.id, s: Math.round(h.score * 1000) / 1000 }));
    const res = d
      .prepare("INSERT INTO retrieval_log (ts, source, project_id, query, hits, served_chars) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Date.now(), source, projectId, q, JSON.stringify(compact), Math.max(0, Math.round(servedChars)));
    const id = Number(res.lastInsertRowid);
    if (id % 50 === 0) pruneRetrievalLog();
    return id;
  } catch {
    return null;
  }
}

export function pruneRetrievalLog(cap = LOG_CAP): number {
  const res = getDb()
    .prepare("DELETE FROM retrieval_log WHERE id <= (SELECT id FROM retrieval_log ORDER BY id DESC LIMIT 1 OFFSET ?)")
    .run(cap);
  return Number(res.changes);
}

export function listRetrievals(limit = 50, source = ""): RetrievalEntry[] {
  const d = getDb();
  const lim = Math.min(LOG_CAP, Math.max(1, Math.floor(limit) || 50));
  const rows = (source
    ? d.prepare("SELECT * FROM retrieval_log WHERE source = ? ORDER BY id DESC LIMIT ?").all(source, lim)
    : d.prepare("SELECT * FROM retrieval_log ORDER BY id DESC LIMIT ?").all(lim)) as Array<{
    id: number;
    ts: number;
    source: string;
    project_id: number | null;
    query: string;
    hits: string;
    served_chars: number;
  }>;
  const marks = d.prepare("SELECT memory_id FROM retrieval_feedback WHERE log_id = ?");
  const mem = d.prepare("SELECT kind, content, archived FROM memories WHERE id = ?");
  return rows.map((r) => {
    let hits: Array<{ id: number; s?: number }> = [];
    try {
      hits = JSON.parse(r.hits || "[]");
    } catch {
      hits = [];
    }
    const flagged = new Set((marks.all(r.id) as Array<{ memory_id: number }>).map((m) => m.memory_id));
    return {
      id: r.id,
      ts: r.ts,
      source: r.source,
      project: r.project_id ? projectSlugById(r.project_id) : null,
      query: r.query || "",
      servedChars: r.served_chars,
      hits: hits.map((h) => {
        const m = mem.get(h.id) as { kind: string; content: string; archived: number } | undefined;
        return {
          id: h.id,
          score: typeof h.s === "number" ? h.s : null,
          kind: m ? m.kind : null,
          content: m ? m.content.replace(/\s+/g, " ").slice(0, 240) : null,
          archived: m ? Number(m.archived) === 1 : false,
          irrelevant: flagged.has(h.id),
        };
      }),
    };
  });
}

/** Mark (or unmark) one memory in one logged retrieval as not relevant. */
export function markIrrelevant(logId: number, memoryId: number, on = true): boolean {
  const d = getDb();
  const row = d.prepare("SELECT query, hits FROM retrieval_log WHERE id = ?").get(logId) as { query: string; hits: string } | undefined;
  if (!row) return false;
  let ids: number[] = [];
  try {
    ids = (JSON.parse(row.hits || "[]") as Array<{ id: number }>).map((h) => h.id);
  } catch {
    ids = [];
  }
  if (!ids.includes(memoryId)) return false;
  if (on) {
    d.prepare(
      "INSERT INTO retrieval_feedback (log_id, memory_id, verdict, query, ts) VALUES (?, ?, 'irrelevant', ?, ?) ON CONFLICT(log_id, memory_id) DO NOTHING"
    ).run(logId, memoryId, row.query, Date.now());
  } else {
    d.prepare("DELETE FROM retrieval_feedback WHERE log_id = ? AND memory_id = ?").run(logId, memoryId);
  }
  return true;
}

export interface RetrievalStats {
  entries: number;
  bySource: Record<string, number>;
  emptyResults: number;
  irrelevantMarks: number;
  enabled: boolean;
}

export function retrievalStats(): RetrievalStats {
  const d = getDb();
  const bySource: Record<string, number> = {};
  for (const r of d.prepare("SELECT source, COUNT(*) AS c FROM retrieval_log GROUP BY source").all() as Array<{ source: string; c: number }>) {
    bySource[r.source] = r.c;
  }
  const entries = Object.values(bySource).reduce((a, b) => a + b, 0);
  const empty = (d.prepare("SELECT COUNT(*) AS c FROM retrieval_log WHERE hits = '[]'").get() as { c: number }).c;
  const marks = (d.prepare("SELECT COUNT(*) AS c FROM retrieval_feedback").get() as { c: number }).c;
  return { entries, bySource, emptyResults: empty, irrelevantMarks: marks, enabled: retrievalLogEnabled() };
}

/** Wipe the log (marks stay unless `withMarks`). */
export function clearRetrievalLog(withMarks = false): void {
  const d = getDb();
  d.exec("DELETE FROM retrieval_log");
  if (withMarks) d.exec("DELETE FROM retrieval_feedback");
}
