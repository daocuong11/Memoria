import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import {
  insertTranscript,
  seqAllocator,
  ensureProject,
  getSourceOffset,
  setSourceOffset,
  insertSessionEvent,
} from "../store/db";
import { projectSlugFromCwd, stripInjectedTags } from "./util";
import { normalizeTodos, opencodeQuestionEvent, toolCallEvents } from "./events";

export function scanOpencode(dbPath: string): { messages: number } {
  if (!fs.existsSync(dbPath)) return { messages: 0 };
  const offset = getSourceOffset("opencode", dbPath);
  const src = new DatabaseSync(dbPath, { readOnly: true });

  try {
    const sessions = src
      .prepare("SELECT id, directory, title, time_created FROM session ORDER BY time_created")
      .all() as Array<{ id: string; directory: string | null; title: string | null; time_created: number }>;

    let total = 0;
    let maxTs = 0;
    let events = 0;
    const event = (sessionId: string, projectId: number | null, ts: number, type: string, sourceRef: string, payload: Record<string, unknown>): void => {
      if (insertSessionEvent({ tool: "opencode", sessionId, projectId, ts, type, sourceRef, payload })) events++;
    };
    // The todo table holds each session's current list. It changes without a
    // new message, so it is read on every scan; the ref changes with it.
    const todoRows = hasTable(src, "todo")
      ? (src.prepare("SELECT session_id, content, status, position, time_updated FROM todo ORDER BY session_id, position").all() as Array<{
          session_id: string;
          content: string;
          status: string;
          time_updated: number;
        }>)
      : [];
    const todoBySession = new Map<string, typeof todoRows>();
    for (const r of todoRows) (todoBySession.get(r.session_id) ?? todoBySession.set(r.session_id, []).get(r.session_id)!).push(r);
    for (const sess of sessions) {
      const cwd = sess.directory || undefined;
      const projectId = ensureProject(projectSlugFromCwd(cwd), cwd);
      const title = (sess.title || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (title) event(sess.id, projectId, sess.time_created || Date.now(), "title", `title:${title}`, { title, source: "session" });
      const table = todoBySession.get(sess.id);
      if (table?.length) {
        const items = normalizeTodos(table);
        const updated = Math.max(...table.map((r) => r.time_updated || 0));
        if (items.length) event(sess.id, projectId, updated || Date.now(), "todo_list", `todo-table:${updated}`, { items, source: "table" });
      }
      const messages = src
        .prepare("SELECT id, time_created, data FROM message WHERE session_id = ? AND time_created > ? ORDER BY time_created")
        .all(sess.id, offset) as Array<{ id: string; time_created: number; data: string }>;

      const nextSeq = seqAllocator("opencode");
      for (const msg of messages) {
        maxTs = Math.max(maxTs, msg.time_created);
        let data: any;
        try {
          data = JSON.parse(msg.data);
        } catch {
          continue;
        }
        const role = data.role === "user" ? "user" : data.role === "assistant" ? "assistant" : "system";
        const parts = src
          .prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created")
          .all(msg.id) as Array<{ id: string; data: string }>;

        // Text parts are the message itself. Tool calls used to be appended to
        // the assistant text as "[command] …", which mixed machine output into
        // what the heuristic extractor reads as the agent's words; they are now
        // separate role "tool" rows (kept for snapshots and search). Synthetic
        // text parts are injected by OpenCode, not typed by anyone.
        const textParts: string[] = [];
        const toolParts: string[] = [];
        const ts = msg.time_created || Date.now();
        for (const p of parts) {
          let pd: any;
          try {
            pd = JSON.parse(p.data);
          } catch {
            continue;
          }
          if (pd.type === "text" && typeof pd.text === "string") {
            if (!pd.synthetic) textParts.push(pd.text);
          } else if (pd.type === "tool" && pd.tool === "todowrite") {
            const items = normalizeTodos(pd.state?.input?.todos);
            if (items.length) event(sess.id, projectId, ts, "todo_list", String(pd.callID || p.id), { items });
          } else if (pd.type === "tool" && pd.tool === "question") {
            const q = opencodeQuestionEvent(pd, String(pd.callID || p.id));
            if (q) event(sess.id, projectId, ts, q.type, q.sourceRef, q.payload);
          } else if (pd.type === "tool" && pd.tool === "bash") {
            const cmd = pd.state?.metadata?.command || pd.state?.input?.command;
            if (cmd) toolParts.push(`$ ${cmd}`);
          }
          if (pd.type === "tool" && pd.state?.status === "completed" && ["bash", "edit", "write", "patch"].includes(pd.tool)) {
            const st = pd.state;
            const output = String(st.output ?? st.metadata?.output ?? "");
            const exit = typeof st.metadata?.exit === "number" ? st.metadata.exit : null;
            for (const e of toolCallEvents(String(pd.callID || p.id), pd.tool, st.input || {}, output, { exitCode: exit }))
              event(sess.id, projectId, ts, e.type, e.sourceRef, e.payload);
          }
        }
        const rows: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }> = [
          { role, content: stripInjectedTags(textParts.join("\n")).trim() },
          { role: "tool", content: toolParts.join("\n").trim() },
        ];
        for (const r of rows) {
          if (!r.content) continue;
          insertTranscript({ tool: "opencode", sessionId: sess.id, projectId, role: r.role, content: r.content, ts, seq: nextSeq(sess.id) });
          total++;
        }
      }
    }
    if (total > 0) setSourceOffset("opencode", dbPath, Math.max(offset, maxTs), fs.statSync(dbPath).mtimeMs);
    return { messages: total + events };
  } finally {
    src.close();
  }
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
