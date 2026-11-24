/* ---------- Auto-triage draft Tier 0 ----------
 * Mengosongkan antrean "Pending approval" tanpa approve manual satu per satu:
 *   1. noise / skor rendah            → archive (bisa dipulihkan)
 *   2. duplikat (draft lain / active) → archive, draft terbaik dipertahankan
 *   3. muncul di ≥2 sesi/tool         → active (corroboration)
 *   4. skor kuat                      → active
 *   5. ragu & lebih tua dari TTL      → archive (expired)
 * Semua perubahan dicatat di triage_log per batch → "Undo triage terakhir".
 * Hanya menyentuh draft origin=heuristic (draft LLM dari reviewMode tidak).
 * ------------------------------------------------------------------------- */
import { randomUUID } from "node:crypto";
import * as db from "../store/db";
import { rescoreStored } from "./heuristic";
import { textSimilarity } from "./dedupe";

export type TriageAction = "promote" | "archive" | "keep";

export interface TriagePlanItem {
  id: number;
  action: TriageAction;
  reason: string;
  score: number;
  projectId: number | null;
  kind: string;
  content: string;
}

export interface TriageSummary {
  batch: string | null;
  dryRun: boolean;
  scanned: number;
  promoted: number;
  archived: number;
  kept: number;
  /** Jumlah per alasan, mis. { "noise:ls-line": 120, "duplicate": 40 }. */
  reasons: Record<string, number>;
  /** Contoh per aksi (maks 6) untuk pratinjau di UI. */
  samples: Record<TriageAction, Array<{ id: number; reason: string; content: string }>>;
}

interface DraftRow {
  id: number;
  project_id: number | null;
  kind: string;
  content: string;
  importance: number;
  created_at: number;
  source_session: string | null;
  source_tool: string | null;
}

const DAY = 86_400_000;

function normKey(s: string): string {
  return s.toLowerCase().replace(/[`*_#>\[\]()"'.,:;!?]/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
}

export function draftTtlDays(): number {
  const n = Number(db.getSetting("draftTtlDays", "14"));
  return Number.isFinite(n) && n > 0 ? n : 14;
}

/** Bangun rencana triage tanpa menulis apa pun. */
export function planTriage(opts: { now?: number; ttlDays?: number; projectId?: number | null } = {}): TriagePlanItem[] {
  const now = opts.now ?? Date.now();
  const ttl = (opts.ttlDays ?? draftTtlDays()) * DAY;
  const d = db.getDb();
  const where = ["archived = 0", "status = 'draft'", "origin = 'heuristic'"];
  const params: Array<number> = [];
  if (opts.projectId != null) {
    where.push("project_id = ?");
    params.push(opts.projectId);
  }
  const drafts = d
    .prepare(
      `SELECT id, project_id, kind, content, importance, created_at, source_session, source_tool, access_count,
              COALESCE(source_event_id, 0) AS source_event_id
       FROM memories WHERE ${where.join(" AND ")} ORDER BY created_at DESC`
    )
    .all(...params) as unknown as DraftRow[];

  // Konten active per proyek (untuk deteksi duplikat terhadap memori yang sudah ada).
  const activeByProject = new Map<string, Array<{ key: string; content: string }>>();
  const actRows = d
    .prepare("SELECT project_id, content FROM memories WHERE archived = 0 AND status = 'active'")
    .all() as Array<{ project_id: number | null; content: string }>;
  for (const r of actRows) {
    const k = String(r.project_id ?? "null");
    if (!activeByProject.has(k)) activeByProject.set(k, []);
    activeByProject.get(k)!.push({ key: normKey(r.content), content: r.content });
  }

  const plan: TriagePlanItem[] = [];
  // Draft yang dipertahankan per proyek → pembanding duplikat + hitung dukungan.
  const keptByProject = new Map<string, Array<{ item: TriagePlanItem; key: string; sessions: Set<string>; tools: Set<string> }>>();

  const userPatterns = userNoisePatterns();
  // "Not relevant" marks from the retrieval inspector (Q1.5) count against a memory.
  const marks = new Map<number, number>();
  try {
    for (const m of d.prepare("SELECT memory_id AS id, COUNT(*) AS c FROM retrieval_feedback GROUP BY memory_id").all() as Array<{ id: number; c: number }>) marks.set(m.id, m.c);
  } catch {
    /* before migration v12 */
  }
  for (const r of drafts) {
    const base = { id: r.id, projectId: r.project_id, kind: r.kind, content: r.content };
    if (userPatterns.length && matchesUserNoise(r.content, userPatterns)) {
      plan.push({ ...base, action: "archive", reason: "noise:user", score: 0 });
      continue;
    }
    const t = rescoreStored(
      { kind: r.kind, content: r.content, importance: r.importance },
      { irrelevantMarks: marks.get(r.id) || 0, accessCount: (r as any).access_count || 0, fromEvent: ((r as any).source_event_id || 0) > 0 }
    );
    if (t.decision === "archive") {
      plan.push({ ...base, action: "archive", reason: t.reason, score: t.score });
      continue;
    }
    const pk = String(r.project_id ?? "null");
    const key = normKey(r.content);
    const actives = activeByProject.get(pk) || [];
    if (actives.some((a) => a.key === key || (Math.abs(a.content.length - r.content.length) < 80 && textSimilarity(a.content, r.content) >= 0.8))) {
      plan.push({ ...base, action: "archive", reason: "duplicate-of-active", score: t.score });
      continue;
    }
    const kept = keptByProject.get(pk) || [];
    const twin = kept.find((k) => k.key === key || (Math.abs(k.item.content.length - r.content.length) < 80 && textSimilarity(k.item.content, r.content) >= 0.8));
    if (twin) {
      // Draft yang lebih baru sudah dipertahankan (urut DESC) → yang ini duplikat,
      // tapi kehadirannya di sesi/tool lain menambah bukti untuk kembarannya.
      if (r.source_session) twin.sessions.add(r.source_session);
      if (r.source_tool) twin.tools.add(r.source_tool);
      plan.push({ ...base, action: "archive", reason: "duplicate", score: t.score });
      continue;
    }
    const item: TriagePlanItem = {
      ...base,
      action: t.decision === "active" ? "promote" : "keep",
      reason: t.decision === "active" ? "strong" : "uncertain",
      score: t.score,
    };
    plan.push(item);
    kept.push({ item, key, sessions: new Set(r.source_session ? [r.source_session] : []), tools: new Set(r.source_tool ? [r.source_tool] : []) });
    keptByProject.set(pk, kept);
    // Tanggal dicatat untuk langkah TTL di bawah.
    (item as TriagePlanItem & { createdAt: number }).createdAt = r.created_at;
  }

  // Corroboration + TTL untuk draft yang masih ragu.
  for (const list of keptByProject.values()) {
    for (const k of list) {
      if (k.item.action !== "keep") continue;
      if (k.sessions.size >= 2 || k.tools.size >= 2) {
        k.item.action = "promote";
        k.item.reason = "corroborated";
        continue;
      }
      const createdAt = (k.item as TriagePlanItem & { createdAt?: number }).createdAt ?? now;
      if (now - createdAt > ttl) {
        k.item.action = "archive";
        k.item.reason = "expired";
      }
    }
    // Inbox cap per project: the inbox must never grow without bound. Keep
    // the best-scoring uncertain drafts, archive the rest.
    const cap = draftCapPerProject();
    const keep = list.filter((k) => k.item.action === "keep").sort((a, b) => b.item.score - a.item.score);
    for (const k of keep.slice(cap)) {
      k.item.action = "archive";
      k.item.reason = "over-cap";
    }
  }
  return plan;
}

export function draftCapPerProject(): number {
  const n = Number(db.getSetting("draftCapPerProject", "50"));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;
}

/* ---------- User noise patterns ("always archive drafts like this") ---------- */

export function userNoisePatterns(): string[] {
  try {
    const v = JSON.parse(db.getSetting("userNoisePatterns", "[]"));
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Plain, case-insensitive substring (never a regex: no injection, no ReDoS). */
export function matchesUserNoise(content: string, patterns = userNoisePatterns()): string | null {
  const lc = (content || "").toLowerCase();
  for (const p of patterns) if (lc.includes(p.toLowerCase())) return p;
  return null;
}

/** Add a pattern and archive every draft that matches it, as one undoable batch. */
export function addUserNoisePattern(pattern: string): { pattern: string; archived: number; batch: string | null } {
  const p = String(pattern || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (p.length < 3) throw new Error("pattern must be at least 3 characters");
  const list = userNoisePatterns();
  if (!list.some((x) => x.toLowerCase() === p.toLowerCase())) db.setSetting("userNoisePatterns", JSON.stringify([...list, p].slice(-200)));
  const drafts = db.getDb()
    .prepare("SELECT id, content, importance, status FROM memories WHERE archived = 0 AND status = 'draft'")
    .all() as Array<{ id: number; content: string; importance: number; status: string }>;
  const hits = drafts.filter((r) => matchesUserNoise(r.content, [p]));
  if (!hits.length) return { pattern: p, archived: 0, batch: null };
  const batch = writeBatch(hits.map((h) => ({ id: h.id, action: "archive" as const, reason: "noise:user", prevStatus: h.status, prevImportance: h.importance })));
  return { pattern: p, archived: hits.length, batch };
}

export function removeUserNoisePattern(pattern: string): string[] {
  const next = userNoisePatterns().filter((x) => x.toLowerCase() !== String(pattern || "").toLowerCase());
  db.setSetting("userNoisePatterns", JSON.stringify(next));
  return next;
}

/* ---------- Stale tasks ---------- */

export function staleTaskDays(): number {
  const n = Number(db.getSetting("staleTaskDays", "30"));
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Open tasks nobody has mentioned for staleTaskDays: archived (undoable),
 * so "Open tasks" in the resume block stays about current work. A task is
 * "mentioned" when a later transcript contains most of its keywords. */
export function archiveStaleTasks(opts: { now?: number; dryRun?: boolean } = {}): { archived: number; batch: string | null; ids: number[] } {
  const now = opts.now ?? Date.now();
  const cutoff = now - staleTaskDays() * DAY;
  const d = db.getDb();
  const tasks = d
    .prepare(
      `SELECT id, project_id, content, importance, status, created_at FROM memories
       WHERE kind = 'task_pending' AND archived = 0 AND COALESCE(resolved_at, 0) = 0 AND created_at < ?`
    )
    .all(cutoff) as Array<{ id: number; project_id: number | null; content: string; importance: number; status: string; created_at: number }>;
  const stale: typeof tasks = [];
  for (const t of tasks) {
    const words = (t.content.toLowerCase().match(/[a-z0-9_-]{4,}/g) || []).filter((w) => !STOP.has(w));
    const kws = [...new Set(words)].slice(0, 5);
    if (!kws.length) continue;
    const need = Math.min(kws.length, Math.max(2, Math.ceil(kws.length * 0.6)));
    const recent = d
      .prepare("SELECT content FROM transcripts WHERE project_id IS ? AND ts > ? AND role IN ('user', 'assistant') ORDER BY ts DESC LIMIT 2000")
      .all(t.project_id, Math.max(t.created_at + DAY, cutoff)) as Array<{ content: string }>;
    const mentioned = recent.some((r) => {
      const lc = r.content.toLowerCase();
      return kws.filter((k) => lc.includes(k)).length >= need;
    });
    if (!mentioned) stale.push(t);
  }
  if (opts.dryRun || !stale.length) return { archived: stale.length, batch: null, ids: stale.map((s) => s.id) };
  const batch = writeBatch(stale.map((s) => ({ id: s.id, action: "archive" as const, reason: "stale-task", prevStatus: s.status, prevImportance: s.importance })));
  return { archived: stale.length, batch, ids: stale.map((s) => s.id) };
}

const STOP = new Set(["yang", "dengan", "untuk", "dari", "pada", "this", "that", "with", "from", "into", "akan", "perlu", "harus", "todo", "tambahkan", "buat", "bikin", "need", "should", "make", "next", "step"]);

/** Apply archive/promote changes as one logged, undoable batch. */
function writeBatch(items: Array<{ id: number; action: "archive" | "promote"; reason: string; prevStatus: string; prevImportance: number }>): string {
  const batch = `t-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const d = db.getDb();
  const log = d.prepare(
    "INSERT INTO triage_log (batch, memory_id, action, reason, prev_status, prev_archived, prev_importance, ts) VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
  );
  const ts = Date.now();
  d.exec("BEGIN");
  try {
    for (const it of items) {
      log.run(batch, it.id, it.action, it.reason, it.prevStatus, it.prevImportance, ts);
      if (it.action === "promote") db.approveMemory(it.id);
      else db.archiveMemory(it.id, true);
    }
    d.exec("COMMIT");
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  }
  db.setSetting("lastTriageBatch", batch);
  db.setSetting("lastTriageAt", String(ts));
  const archived = items.filter((i) => i.action === "archive").length;
  db.setSetting("triageArchivedTotal", String((Number(db.getSetting("triageArchivedTotal", "0")) || 0) + archived));
  return batch;
}

function summarize(plan: TriagePlanItem[], batch: string | null, dryRun: boolean): TriageSummary {
  const s: TriageSummary = {
    batch,
    dryRun,
    scanned: plan.length,
    promoted: 0,
    archived: 0,
    kept: 0,
    reasons: {},
    samples: { promote: [], archive: [], keep: [] },
  };
  for (const p of plan) {
    if (p.action === "promote") s.promoted++;
    else if (p.action === "archive") s.archived++;
    else s.kept++;
    s.reasons[p.reason] = (s.reasons[p.reason] || 0) + 1;
    const bucket = s.samples[p.action];
    if (bucket.length < 6) bucket.push({ id: p.id, reason: p.reason, content: p.content.slice(0, 180) });
  }
  return s;
}

/** Jalankan triage. dryRun=true hanya mengembalikan pratinjau. */
export function runTriage(opts: { dryRun?: boolean; now?: number; ttlDays?: number; projectId?: number | null } = {}): TriageSummary {
  const plan = planTriage(opts);
  const changes = plan.filter((p) => p.action !== "keep");
  if (opts.dryRun || !changes.length) return summarize(plan, null, !!opts.dryRun);
  const batch = `t-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const d = db.getDb();
  const log = d.prepare(
    "INSERT INTO triage_log (batch, memory_id, action, reason, prev_status, prev_archived, prev_importance, ts) VALUES (?, ?, ?, ?, 'draft', 0, ?, ?)"
  );
  const ts = Date.now();
  d.exec("BEGIN");
  try {
    for (const p of changes) {
      const cur = db.memoryById(p.id);
      if (!cur) continue;
      log.run(batch, p.id, p.action, p.reason, cur.importance, ts);
      if (p.action === "promote") {
        db.approveMemory(p.id);
        if (cur.importance < 0.52) db.updateMemory(p.id, { importance: 0.52 });
      } else {
        db.archiveMemory(p.id, true);
      }
    }
    d.exec("COMMIT");
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* sudah batal */
    }
    throw err;
  }
  db.setSetting("lastTriageBatch", batch);
  db.setSetting("lastTriageAt", String(ts));
  const total = (Number(db.getSetting("triageArchivedTotal", "0")) || 0) + changes.filter((c) => c.action === "archive").length;
  db.setSetting("triageArchivedTotal", String(total));
  return summarize(plan, batch, false);
}

/** Batalkan satu batch triage (default: batch terakhir). */
export function undoTriage(batch?: string): { batch: string | null; restored: number } {
  const target = batch || db.getSetting("lastTriageBatch", "");
  if (!target) return { batch: null, restored: 0 };
  const d = db.getDb();
  const rows = d
    .prepare("SELECT memory_id, action, prev_importance, prev_status FROM triage_log WHERE batch = ?")
    .all(target) as Array<{ memory_id: number; action: string; prev_importance: number | null; prev_status: string | null }>;
  let restored = 0;
  let unarchived = 0;
  d.exec("BEGIN");
  try {
    for (const r of rows) {
      if (!db.memoryById(r.memory_id)) continue;
      if (r.action === "archive") {
        db.archiveMemory(r.memory_id, false);
        unarchived++;
      }
      // Back to the status it had before (stale-task archiving touches active tasks).
      const prevStatus = r.prev_status === "active" ? "active" : "draft";
      d.prepare("UPDATE memories SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(prevStatus, Date.now(), db.getDeviceId(), r.memory_id);
      if (r.prev_importance != null) db.updateMemory(r.memory_id, { importance: r.prev_importance });
      restored++;
    }
    d.prepare("DELETE FROM triage_log WHERE batch = ?").run(target);
    d.exec("COMMIT");
  } catch (err) {
    try {
      d.exec("ROLLBACK");
    } catch {
      /* sudah batal */
    }
    throw err;
  }
  db.bumpDataVersion();
  const total = Math.max(0, (Number(db.getSetting("triageArchivedTotal", "0")) || 0) - unarchived);
  db.setSetting("triageArchivedTotal", String(total));
  const prev = d.prepare("SELECT batch FROM triage_log ORDER BY id DESC LIMIT 1").get() as { batch: string } | undefined;
  db.setSetting("lastTriageBatch", prev?.batch || "");
  return { batch: target, restored };
}

/** Status ringkas untuk dashboard. */
export function triageStatus(): { lastBatch: string; lastAt: number; archivedTotal: number; drafts: number; ttlDays: number; auto: boolean } {
  return {
    lastBatch: db.getSetting("lastTriageBatch", ""),
    lastAt: Number(db.getSetting("lastTriageAt", "0")) || 0,
    archivedTotal: Number(db.getSetting("triageArchivedTotal", "0")) || 0,
    drafts: db.countDraft(),
    ttlDays: draftTtlDays(),
    auto: db.getBoolSetting("autoTriage", true),
  };
}
