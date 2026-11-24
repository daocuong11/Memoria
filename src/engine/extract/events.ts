/* Session events → memories (quality phase Q2a).
 *
 * Todo lists: every item becomes one task memory with the agent's own status
 * (pending / in_progress → task_pending, completed → task_done, cancelled →
 * archived). The latest list of a session decides; an item that drops out of
 * a later list keeps its last known status. These are `working` memories:
 * they matter while the work is going on.
 *
 * Answered questions: a real choice becomes a `decision` ("question → answer").
 * An answer that is itself a question (the user asks back) is not a decision.
 * A one- or two-word reply that is not one of the offered options ("ok",
 * "gas"), a short "yes, do it" to a one-off action, and a long free-text
 * reply (usually an explanation or a paste) stay `working`. An unanswered
 * question is skipped.
 *
 * Titles stay events only (the resume block reads them later).
 *
 * Progress is tracked by the highest event id processed, so each event is
 * handled once. Re-processing is safe: memories are looked up by content. */
import {
  archiveMemory,
  getDb,
  getSetting,
  insertMemory,
  markResolved,
  setSetting,
  updateMemory,
  type SessionEvent,
} from "../store/db";
import type { AnsweredQuestion, TodoItem } from "../ingest/events";

const CURSOR_KEY = "eventsProcessedId";
const TASK_IMPORTANCE = 0.6;
const DAY = 86_400_000;
/** Working memories carry an expiry; serving them is filtered in the
 * lifecycle step (Q5). Open todos: 7 days after the list, done: 3 days. */
const TODO_TTL = { task_pending: 7 * DAY, task_done: 3 * DAY } as const;
const DECISION_IMPORTANCE = 0.7;
const APPROVAL_START = /^(?:ok(?:e|ay)?|ya|yes|iya|sip|gas|lanjut|boleh|setuju|go|sure|jalan(?:in|kan)?)\b/i;
const APPROVAL = /^(?:ok(?:e|ay)?|ya|yes|y|iya|sip|gas|lanjut|boleh|setuju|go|sure|no|tidak|nggak|gak|skip|done)[.!]?$/i;

type Embed = (text: string) => Promise<number[] | null | undefined>;
let embedModel = "";

export interface MaterializeResult {
  events: number;
  created: number;
  updated: number;
  archived: number;
}

interface Row {
  id: number;
  tool: string;
  session_id: string;
  project_id: number | null;
  ts: number;
  type: string;
  payload: string;
  git_branch: string | null;
}

function parse(r: Row): SessionEvent {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(r.payload || "{}");
  } catch {
    payload = {};
  }
  return { id: r.id, tool: r.tool, sessionId: r.session_id, projectId: r.project_id, ts: r.ts, type: r.type, sourceRef: "", payload, gitBranch: r.git_branch || "" };
}

function findMemory(projectId: number | null, kinds: string[], content: string): { id: number; kind: string; archived: number } | undefined {
  return getDb()
    .prepare(
      `SELECT id, kind, archived FROM memories WHERE project_id IS ? AND kind IN (${kinds.map(() => "?").join(",")}) AND content = ?
       ORDER BY archived, id DESC LIMIT 1`
    )
    .get(projectId, ...kinds, content) as { id: number; kind: string; archived: number } | undefined;
}

export function questionDecision(q: AnsweredQuestion): { content: string; memoryClass: "working" | "durable" } | null {
  const answer = q.answer.trim();
  if (!answer || !q.question) return null;
  if (/\?\s*$/.test(answer)) return null; // the user asked back
  if (/^\[User did not answer/i.test(answer)) return null; // they replied in chat instead
  const picked = q.options.some((o) => o.toLowerCase() === answer.toLowerCase() || answer.toLowerCase().includes(o.toLowerCase()));
  const words = answer.split(/\s+/).filter(Boolean).length;
  // "ya, jalanin sekarang" approves one action; it is not a lasting choice.
  const approves = APPROVAL_START.test(answer) && words <= 5;
  // A long free-text reply is usually an explanation, a paste or a question
  // back, not a choice: keep it as working context, not a lasting decision.
  const rambling = !picked && words >= 12;
  const passing = (!picked && (APPROVAL.test(answer) || words <= 2)) || approves || rambling;
  const subject = q.question.replace(/\s+/g, " ").trim().slice(0, 300);
  return { content: `${subject} → ${answer}`, memoryClass: passing ? "working" : "durable" };
}

async function upsertTodo(ev: SessionEvent, item: TodoItem, embed: Embed, out: MaterializeResult): Promise<void> {
  const existing = findMemory(ev.projectId, ["task_pending", "task_done"], item.content);
  if (item.status === "cancelled") {
    if (existing && !existing.archived && existing.kind === "task_pending" && archiveMemory(existing.id, true)) out.archived++;
    return;
  }
  const kind = item.status === "completed" ? "task_done" : "task_pending";
  if (existing) {
    if (existing.archived) return; // archived by the user or triage: respect it
    if (existing.kind !== kind) {
      // Expiry first: updateMemory queues the sync snapshot that carries it.
      getDb().prepare("UPDATE memories SET expires_at = ? WHERE id = ?").run(ev.ts + TODO_TTL[kind], existing.id);
      updateMemory(existing.id, { kind });
      if (kind === "task_done") markResolved(existing.id);
      out.updated++;
    }
    return;
  }
  const embedding = (await embed(item.content)) || null;
  const id = insertMemory({
    projectId: ev.projectId,
    kind,
    content: item.content,
    importance: TASK_IMPORTANCE,
    createdAt: ev.ts,
    lastAccessed: 0,
    accessCount: 0,
    sourceTool: ev.tool,
    embedding,
    status: "active",
    origin: "heuristic",
    sourceSession: ev.sessionId,
    sourceEventId: ev.id,
    gitBranch: ev.gitBranch,
    memoryClass: "working",
    expiresAt: ev.ts + TODO_TTL[kind],
    embedModel: embedding ? embedModel : "",
  });
  if (kind === "task_done") markResolved(id);
  out.created++;
}

async function upsertDecision(ev: SessionEvent, q: AnsweredQuestion, embed: Embed, out: MaterializeResult): Promise<void> {
  const d = questionDecision(q);
  if (!d || findMemory(ev.projectId, ["decision"], d.content)) return;
  const embedding = (await embed(d.content)) || null;
  insertMemory({
    projectId: ev.projectId,
    kind: "decision",
    content: d.content,
    importance: d.memoryClass === "durable" ? DECISION_IMPORTANCE : 0.4,
    createdAt: ev.ts,
    lastAccessed: 0,
    accessCount: 0,
    sourceTool: ev.tool,
    embedding,
    embedModel: embedding ? embedModel : "",
    status: "active",
    origin: "heuristic",
    sourceSession: ev.sessionId,
    sourceEventId: ev.id,
    gitBranch: ev.gitBranch,
    memoryClass: d.memoryClass,
  });
  out.created++;
}

/** Turn new session events into memories. `embed` gives the vector for new
 * memories (the active embedding provider). */
export async function materializeEvents(embed: Embed, opts: { limit?: number; embedModel?: string } = {}): Promise<MaterializeResult> {
  embedModel = opts.embedModel || "";
  const out: MaterializeResult = { events: 0, created: 0, updated: 0, archived: 0 };
  const d = getDb();
  const from = Number(getSetting(CURSOR_KEY, "0")) || 0;
  const rows = d
    .prepare("SELECT id, tool, session_id, project_id, ts, type, payload, git_branch FROM session_events WHERE id > ? ORDER BY id LIMIT ?")
    .all(from, opts.limit ?? 5000) as unknown as Row[];
  if (!rows.length) return out;
  // Todo lists: only the newest list per session matters, but an item seen
  // only in an older list still counts (with its last status).
  const lists = new Map<string, SessionEvent[]>();
  for (const r of rows) {
    const ev = parse(r);
    out.events++;
    if (ev.type === "todo_list") {
      const key = `${ev.tool}\u0000${ev.sessionId}`;
      (lists.get(key) ?? lists.set(key, []).get(key)!).push(ev);
    } else if (ev.type === "question") {
      for (const q of (ev.payload.questions as AnsweredQuestion[]) || []) await upsertDecision(ev, q, embed, out);
    }
  }
  for (const evs of lists.values()) {
    evs.sort((a, b) => a.ts - b.ts || (a.id ?? 0) - (b.id ?? 0));
    const last = new Map<string, { ev: SessionEvent; item: TodoItem }>();
    for (const ev of evs) for (const item of (ev.payload.items as TodoItem[]) || []) last.set(item.content.toLowerCase(), { ev, item });
    for (const { ev, item } of last.values()) await upsertTodo(ev, item, embed, out);
  }
  setSetting(CURSOR_KEY, String(rows[rows.length - 1].id));
  return out;
}
