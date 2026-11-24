import * as fs from "node:fs";
import {
  getSourceOffset,
  setSourceOffset,
  insertTranscript,
  seqAllocator,
  ensureProject,
  insertSessionEvent,
  getDb,
} from "../store/db";
import { claudeQuestionEvent, claudeTitleEvent, claudeTodoEvents, toolCallEvents, type EventDraft } from "./events";
import { withTx } from "../store/tx";
import { walkFiles, safeJson, textFromContent, projectSlugFromCwd, readLinesIncremental, isToolResultOnly, stripInjectedTags } from "./util";

export async function scanClaude(root: string, log?: (msg: string) => void): Promise<{ files: number; lines: number }> {
  // A single transcript file is accepted too (Claude Code hooks pass transcript_path).
  let isFile = false;
  try {
    isFile = fs.statSync(root).isFile();
  } catch {
    /* missing root: walkFiles returns [] */
  }
  const files = isFile ? (root.endsWith(".jsonl") ? [root] : []) : walkFiles(root, [".jsonl"]);
  let totalLines = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const mtime = fs.statSync(file).mtimeMs;
    const stored = getSourceOffset("claude", file);
    const { lines, finalOffset } = await readLinesIncremental(file, stored);
    if (!lines.length) {
      if (finalOffset > stored) setSourceOffset("claude", file, finalOffset, mtime);
      continue;
    }
    const nextSeq = seqAllocator("claude");
    withTx(() => {
      // Titles may come before the first message that names the project.
      const projectOf = new Map<string, number>();
      const lastTs = new Map<string, number>();
      const titles: Array<{ sessionId: string; e: EventDraft }> = [];
      // tool_use id → call, to pair with its tool_result in a later line.
      const calls = new Map<string, { name: string; input: Record<string, any> }>();
      const addEvent = (e: EventDraft, sessionId: string, projectId: number | null, ts: number, gitBranch: string): void => {
        insertSessionEvent({ tool: "claude", sessionId, projectId, ts, type: e.type, sourceRef: e.sourceRef, payload: e.payload, gitBranch });
      };
      for (const line of lines) {
        const j = safeJson(line);
        if (!j) continue;
        const title = claudeTitleEvent(j);
        if (title && j.sessionId) titles.push({ sessionId: String(j.sessionId), e: title });
        if (j.type !== "user" && j.type !== "assistant") continue;
        const ts = Date.parse(j.timestamp || "") || 0;
        const cwd = j.cwd || j.project_path;
        const sessionId = j.sessionId || j.session_id || "n/a";
        const projectId = ensureProject(projectSlugFromCwd(cwd), cwd);
        projectOf.set(sessionId, projectId);
        if (ts) lastTs.set(sessionId, ts);
        const rawContent = j.message?.content;
        const eventTs = ts || Date.now();
        const branch = typeof j.gitBranch === "string" ? j.gitBranch : "";
        // Peran sebenarnya: tool_result yang dibungkus pesan "user" → "tool";
        // pesan meta suntikan CLI (isMeta) → "system".
        const role = isToolResultOnly(rawContent) ? "tool" : j.isMeta ? "system" : j.type;
        const content = role === "tool" ? textFromContent(rawContent) : stripInjectedTags(textFromContent(rawContent));
        if (content) {
          insertTranscript({
            tool: "claude",
            sessionId,
            projectId,
            role,
            content,
            ts: ts || Date.now(),
            seq: nextSeq(sessionId),
          });
          totalLines++;
        }
        // Todo lists (TodoWrite, update_plan) and answered questions become
        // session events; extract/events.ts turns them into memories with the
        // agent's own status instead of guessing from a checklist text row.
        if (j.type === "assistant") {
          for (const e of claudeTodoEvents(rawContent)) addEvent(e, sessionId, projectId, eventTs, branch);
          if (Array.isArray(rawContent))
            for (const b of rawContent) if (b && b.type === "tool_use" && b.id) calls.set(String(b.id), { name: String(b.name || ""), input: b.input || {} });
        }
        if (j.type === "user") {
          const q = claudeQuestionEvent(j);
          if (q) addEvent(q, sessionId, projectId, eventTs, branch);
          // Verifier runs, file edits and commits, judged from the result.
          if (Array.isArray(rawContent))
            for (const b of rawContent) {
              if (!b || b.type !== "tool_result") continue;
              const call = calls.get(String(b.tool_use_id || ""));
              if (!call) continue;
              const r = j.toolUseResult;
              const output = r && typeof r === "object" && typeof r.stdout === "string" ? `${r.stdout}\n${r.stderr || ""}` : textFromContent(b.content);
              for (const e of toolCallEvents(String(b.tool_use_id), call.name, call.input, output, { isError: b.is_error === true }))
                addEvent(e, sessionId, projectId, eventTs, branch);
            }
        }
      }
      const knownProject = getDb().prepare("SELECT project_id AS p, MAX(ts) AS t FROM transcripts WHERE tool = 'claude' AND session_id = ?");
      for (const t of titles) {
        const known = projectOf.has(t.sessionId) ? null : (knownProject.get(t.sessionId) as { p: number | null; t: number | null } | undefined);
        addEvent(t.e, t.sessionId, projectOf.get(t.sessionId) ?? known?.p ?? null, lastTs.get(t.sessionId) || known?.t || Date.now(), "");
      }
    });
    setSourceOffset("claude", file, finalOffset, mtime);
    if (log && (i % 10 === 0 || i === files.length - 1)) {
      log(`claude: ${i + 1}/${files.length} file, ${totalLines} pesan`);
    }
  }
  return { files: files.length, lines: totalLines };
}
