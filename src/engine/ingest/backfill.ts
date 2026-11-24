/* Backfill of structured session events (quality phase step 14).
 *
 * Sessions read before v0.17 have transcripts but no session events. This
 * re-reads the Claude Code and OpenCode sources from the start (transcripts
 * already stored are recognized and skipped; events are unique per source
 * id), turns the events into memories, and archives the older heuristic
 * task memories that duplicate a todo now captured with its real status.
 *
 * Safe to run again: a second run adds nothing. A backup is written first,
 * and the duplicate archiving is one triage batch (`maintain triage --undo`). */
import { randomUUID } from "node:crypto";
import { getDb, setSetting } from "../store/db";

const TOOLS = ["claude", "opencode"] as const;

export interface BackfillResult {
  backup: string | null;
  events: Record<string, number>;
  memoriesCreated: number;
  duplicatesArchived: number;
  batch: string | null;
  newTranscripts: number;
}

function countEvents(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of getDb().prepare("SELECT tool || '/' || type AS k, COUNT(*) AS c FROM session_events GROUP BY 1").all() as Array<{ k: string; c: number }>)
    out[r.k] = r.c;
  return out;
}

const CHECKBOX = /^\s*(?:[-*]\s*)?\[[ xX]\]\s*/;
const norm = (s: string): string => s.replace(CHECKBOX, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Heuristic task memories (from the old checklist rows) that say the same
 * as a todo memory built from an event, in the same project. */
export function findTodoDuplicates(): Array<{ id: number; status: string; importance: number }> {
  const d = getDb();
  const fromEvents = d
    .prepare("SELECT project_id, content FROM memories WHERE source_event_id > 0 AND kind IN ('task_pending', 'task_done')")
    .all() as Array<{ project_id: number | null; content: string }>;
  const keys = new Set(fromEvents.map((m) => `${m.project_id}\u0000${norm(m.content)}`));
  const old = d
    .prepare(
      `SELECT id, project_id, content, status, importance FROM memories
       WHERE COALESCE(source_event_id, 0) = 0 AND origin = 'heuristic' AND archived = 0 AND kind IN ('task_pending', 'task_done')`
    )
    .all() as Array<{ id: number; project_id: number | null; content: string; status: string; importance: number }>;
  return old.filter((m) => keys.has(`${m.project_id}\u0000${norm(m.content)}`)).map((m) => ({ id: m.id, status: m.status, importance: m.importance }));
}

export async function backfillEvents(opts: { log?: (m: string) => void } = {}): Promise<BackfillResult> {
  const log = opts.log ?? (() => {});
  const { backupDb } = await import("../store/backup");
  const backup = backupDb();
  log(backup ? `Backup: ${backup}` : "Backup failed (continuing: migrations already took a snapshot)");
  const d = getDb();
  const transcriptsBefore = (d.prepare("SELECT COUNT(*) AS c FROM transcripts").get() as { c: number }).c;

  // Re-read from the start. Offsets are byte positions (Claude Code) or a
  // timestamp (OpenCode); 0 means "everything".
  d.prepare(`UPDATE sources SET offset = 0 WHERE tool IN (${TOOLS.map(() => "?").join(",")})`).run(...TOOLS);
  // Only the two parsers, never scanAll: a full scan also runs limit-signal
  // handling, which writes resume blocks into project files (AGENTS.md, …).
  const { getConfig } = await import("../config");
  const { scanClaude } = await import("./claude");
  const { scanOpencode } = await import("./opencode");
  for (const src of getConfig().sources) {
    if (src.tool === "claude") for (const p of src.paths) await scanClaude(p, log);
    if (src.tool === "opencode" && src.paths[0]) scanOpencode(src.paths[0]);
  }

  const { getEmbedProvider } = await import("../extract/provider");
  const { materializeEvents } = await import("../extract/events");
  const ep = await getEmbedProvider();
  let created = 0;
  for (;;) {
    const r = await materializeEvents((t) => ep.embed(t), { embedModel: ep.embedModel });
    created += r.created;
    if (!r.events) break;
  }

  const dups = findTodoDuplicates();
  let batch: string | null = null;
  if (dups.length) {
    batch = `backfill-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const logStmt = d.prepare(
      "INSERT INTO triage_log (batch, memory_id, action, reason, prev_status, prev_archived, prev_importance, ts) VALUES (?, ?, 'archive', 'todo-duplicate', ?, 0, ?, ?)"
    );
    const { archiveMemory } = await import("../store/db");
    d.exec("BEGIN");
    try {
      for (const m of dups) {
        archiveMemory(m.id, true);
        logStmt.run(batch, m.id, m.status, m.importance, Date.now());
      }
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
    setSetting("lastTriageBatch", batch);
  }
  const transcriptsAfter = (d.prepare("SELECT COUNT(*) AS c FROM transcripts").get() as { c: number }).c;
  return { backup, events: countEvents(), memoriesCreated: created, duplicatesArchived: dups.length, batch, newTranscripts: transcriptsAfter - transcriptsBefore };
}
