import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ensureDb } from "../ingest/manager";
import { searchMemories, projectContext, touchMemories } from "../retrieve/search";
import { ensureProject, memoryById, effectiveStatus, getDb, resolveProject, updateMemory, deleteMemory } from "../store/db";
import { looksLikePath, projectSlugFromCwd } from "../ingest/util";
import { getEmbedProvider } from "../extract/provider";
import { relatedMemories } from "../graph";
import { addMemoryWithDedupe } from "../extract/dedupe";
import { buildContextBlock } from "../retrieve/contextblock";
import { emitEvent } from "../events";
import { recordContextServed } from "../retrieve/usage";
import { fileContext } from "../retrieve/filecontext";

const TOOL_DESC = `
You have access to persistent memory (a second brain) from every AI coding tool the user has used (Claude, Codex, opencode, Gemini, Copilot, Antigravity).
USE these tools at the START of a new session to retrieve context about previous work, and whenever the user asks about prior work.

How to use:
1. At session start, call project_context (compact index) or recall with keywords relevant to the user's task; read the full text of the entries you need with get_memory.
2. Before changing code, recall project context: decisions, pending tasks, fixed errors, preferences.
3. After finishing a task, call remember to store new memories.
4. If a stored memory is wrong or outdated, correct it with update_memory (auto re-embeds) or remove it with forget.
`;

/** Progressive disclosure: satu baris per memori (id + jenis + cuplikan).
 * Memori pendek tampil utuh; yang panjang dipotong dan ditandai "…" agar
 * agen tahu harus memanggil get_memory untuk detailnya. */
export const INDEX_SNIPPET = 110;
export function indexText(hits: Array<{ id: number; kind: string; content: string }>): string {
  let truncated = 0;
  const lines = hits.map((h) => {
    const one = h.content.replace(/\s+/g, " ").trim();
    // Project brief = ringkasan inti proyek, selalu utuh.
    const cut = h.kind !== "brief" && one.length > INDEX_SNIPPET;
    if (cut) truncated++;
    return `#${h.id} [${h.kind}] ${cut ? one.slice(0, INDEX_SNIPPET - 1).trimEnd() + "…" : one}`;
  });
  const hint = truncated
    ? `\n\n${truncated} entr${truncated === 1 ? "y is" : "ies are"} truncated (…). Call get_memory with their ids for full text.`
    : "";
  return lines.join("\n") + hint;
}

/** Versi dari package.json (dulu hardcode "0.1.0" sementara app sudah 0.12). */
function appVersion(): string {
  try {
    // dist/engine/mcp/server.js → root paket (juga berlaku di dalam asar Electron)
    return String(require("../../../package.json").version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

export function createMcpServer(): Server {
  ensureDb();
  const server = new Server(
    { name: "memoria", version: appVersion() },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "recall",
        annotations: { title: "Recall memories", readOnlyHint: true, openWorldHint: false },
        description:
          "Search memories of previous work by keywords/question. Returns facts, decisions, tasks and fixed errors. Call at session start!",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Question or keywords, e.g. \"why did the build fail\"" },
            limit: { type: "number", default: 8, description: "Maximum number of results" },
            project: { type: "string", description: "Optional — limit to one project (path or name)" },
            maxChars: { type: "number", description: "Optional — cut the result at N characters to fit the context window" },
            mode: { type: "string", enum: ["full", "index"], default: "full", description: "\"index\" = one line per hit with id; get details with get_memory" },
          },
          required: ["query"],
        },
      },
      {
        name: "project_context",
        annotations: { title: "Project context", readOnlyHint: true, openWorldHint: false },
        description:
          "Return the latest context of a project: decisions, pending tasks, completed work. Default mode \"index\" returns one compact line per memory with its id (cheap on tokens); call get_memory with the ids you need for full text. Use mode \"full\" to get everything at once.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project path or name" },
            limit: { type: "number", default: 10, description: "Maximum number of memories" },
            mode: { type: "string", enum: ["index", "full"], default: "index", description: "\"index\" = one line per memory with id; \"full\" = complete text" },
          },
          required: ["project"],
        },
      },
      {
        name: "file_context",
        annotations: { title: "File context", readOnlyHint: true, openWorldHint: false },
        description:
          "Before editing a file, ask what is known about it: fixed errors, decisions, open tasks and preferences that mention this file path. Pass an absolute or relative path.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path, e.g. src/engine/http.ts" },
            project: { type: "string", description: "Optional — limit to one project (path or name)" },
            limit: { type: "number", default: 8, description: "Maximum number of results" },
          },
          required: ["path"],
        },
      },
      {
        name: "get_memory",
        annotations: { title: "Get memories", readOnlyHint: true, openWorldHint: false },
        description: "Return the full text of specific memories by id (ids come from project_context, recall, or related).",
        inputSchema: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "number" }, description: "Memory ids (max 20)" },
          },
          required: ["ids"],
        },
      },
      {
        name: "remember",
        annotations: { title: "Remember", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
        description: "Store an important memory (decision, fact, user preference, completed/pending task) so every tool remembers it.",
        inputSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["fact", "decision", "task_done", "task_pending", "error_fixed", "preference", "context"],
              description: "Memory type: decision, fact, preference, open task (task_pending), finished task (task_done), fixed error (error_fixed) or general context",
            },
            content: { type: "string", description: "Memory content, short and dense" },
            project: { type: "string", description: "Optional — project path or name; omit for a global memory" },
            importance: { type: "number", default: 0.5, description: "0 to 1; higher ranks first in context" },
          },
          required: ["kind", "content"],
        },
      },
      {
        name: "related",
        annotations: { title: "Related memories", readOnlyHint: true, openWorldHint: false },
        description:
          "Return memories connected (backlinks/similarity) to one memory. Use when recall context is incomplete or you need related detail. Pass a memory id or a text query.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Memory id from recall or project_context" },
            query: { type: "string", description: "Or keywords: the closest memory is found first, then its connections are returned" },
          },
        },
      },
      {
        name: "update_memory",
        annotations: { title: "Update memory", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        description:
          "Correct an existing memory: replace its content (auto re-embedded so semantic search stays accurate), change its kind, or adjust importance. Pass the memory id from recall.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Memory id from recall" },
            content: { type: "string", description: "Replacement content, short and dense" },
            kind: {
              type: "string",
              enum: ["fact", "decision", "task_done", "task_pending", "error_fixed", "preference", "context"],
              description: "Memory type: decision, fact, preference, open task (task_pending), finished task (task_done), fixed error (error_fixed) or general context",
            },
            importance: { type: "number", description: "New importance, 0 to 1" },
          },
          required: ["id"],
        },
      },
      {
        name: "forget",
        annotations: { title: "Forget memory", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
        description:
          "Delete a stale or wrong memory. Pass the memory id for a direct delete, or a query: a confident match is deleted immediately, otherwise candidates are listed for you to pick an explicit id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Memory id (direct delete)" },
            query: { type: "string", description: "Keywords to find the memory to forget" },
          },
        },
      },
      {
        name: "build_context",
        annotations: { title: "Build context block", readOnlyHint: true, openWorldHint: false },
        description:
          "One ready-to-use context block for a project: auto-maintained project brief + key memories + optional query matches + 1-hop relations, capped to maxChars. Ideal first call at session start.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project path or name" },
            query: { type: "string", description: "Optional focus — matching memories are added to the block" },
            maxChars: { type: "number", default: 6000, description: "Upper bound on the block size in characters" },
          },
          required: ["project"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, any>;

    switch (name) {
      case "recall": {
        const query = String(a.query || "");
        // Embed query agar skor semantik aktif — tanpa ini recall MCP hanya keyword.
        const eprov = await getEmbedProvider();
        const qEmb = await eprov.embed(query);
        // PR-M: scope proyek opsional — bridge lintas-AI jadi bisa bertanya
        // "recall khusus proyek X" tanpa menyaring hasil manual.
        const projInput = String(a.project || "");
        const projRec = projInput ? resolveProject(projInput) : null;
        const results = searchMemories(
          query,
          { limit: Number(a.limit || 8), embedModel: eprov.embedModel, projectSlug: projRec?.slug },
          qEmb
        );
        if (!results.length) {
          return {
            content: [{ type: "text", text: "No matching memories. This is a fresh session - proceed with the user's task as usual." }],
          };
        }
        // PR-M: budget token — agent bisa membatasi panjang blok konteks agar
        // tidak melampaui context window-nya (default: tanpa batas).
        const maxChars = Number(a.maxChars || 0);
        const cap = (s: string): string => (maxChars > 0 && s.length > maxChars ? s.slice(0, maxChars - 1) + "…\n(truncated at maxChars=" + maxChars + ")" : s);
        const full = results
          .map(
            (r) =>
              `[${r.kind}] (id ${r.id}, ${r.projectSlug ?? "global"}, ${r.sourceTool}, importance ${r.importance.toFixed(2)}${r.superseded ? ", SUPERSEDED by a newer decision" : ""})\n${r.content}`
          )
          .join("\n\n");
        if (a.mode === "index") {
          const idx = indexText(results);
          recordContextServed("recall", projRec?.id ?? null, idx.length, full.length);
          return { content: [{ type: "text", text: idx }] };
        }
        const text = full;
        // A5: lampirkan relasi 1-hop dari 2 hit teratas — konteks kaya tanpa
        // panggilan tambahan (traversal graphiti-style, dangkal & murah).
        const relLines: string[] = [];
        for (const h of results.slice(0, 2)) {
          const rel = relatedMemories(h.id, 2);
          for (const r of rel) {
            if (!results.some((x) => x.id === r.memory.id)) {
              relLines.push(`  ↳ [${r.linkKind}] (id ${r.memory.id}) ${r.memory.content.replace(/\s+/g, " ").slice(0, 110)}`);
            }
          }
        }
        const withRel = cap(relLines.length ? `${text}\n\nRelated:\n${relLines.join("\n")}` : text);
        recordContextServed("recall", projRec?.id ?? null, withRel.length);
        return { content: [{ type: "text", text: withRel }] };
      }
      case "build_context": {
        // A3: satu blok konteks siap-tempel — brief + memori kunci + query +
        // relasi 1-hop, dibatasi maxChars (ala build_context / context string).
        const project = String(a.project || "");
        if (!project) {
          return { content: [{ type: "text", text: "project is required (path atau nama proyek)." }] };
        }
        const eprov = a.query ? await getEmbedProvider() : null;
        const qEmb = eprov && a.query ? await eprov.embed(String(a.query)) : null;
        const block = buildContextBlock({
          project,
          query: a.query ? String(a.query) : undefined,
          limit: Number(a.limit || 12),
          maxChars: Number(a.maxChars || 6000),
          embedModel: eprov?.embedModel,
          queryEmbedding: qEmb,
        });
        recordContextServed("build_context", resolveProject(project)?.id ?? null, block.length);
        return { content: [{ type: "text", text: block }] };
      }
      case "project_context": {
        const proj = resolveProject(String(a.project || ""));
        const results = proj ? projectContext(proj.slug, Number(a.limit || 10)) : [];
        if (!results.length) {
          return { content: [{ type: "text", text: `No memories stored for project "${a.project}".` }] };
        }
        const full = results
          .map((r) => `[${r.kind}] ${r.content}`)
          .join("\n\n");
        if (a.mode === "full") {
          recordContextServed("project_context", proj?.id ?? null, full.length);
          return { content: [{ type: "text", text: full }] };
        }
        const idx = indexText(results);
        recordContextServed("project_context", proj?.id ?? null, idx.length, full.length);
        return { content: [{ type: "text", text: idx }] };
      }
      case "file_context": {
        const p = String(a.path || "").trim();
        if (!p) return { content: [{ type: "text", text: "path is required." }] };
        const hits = fileContext(p, { project: a.project ? String(a.project) : undefined, limit: Number(a.limit || 8) });
        if (!hits.length) {
          return { content: [{ type: "text", text: `No memories mention ${p}.` }] };
        }
        const text = `Known about ${p}:\n` + hits.map((h) => `- #${h.id} [${h.kind}] ${h.content.replace(/\s+/g, " ")}`).join("\n");
        touchMemories(hits.map((h) => h.id));
        recordContextServed("file_context", hits[0].projectId, text.length);
        return { content: [{ type: "text", text }] };
      }
      case "get_memory": {
        const ids = (Array.isArray(a.ids) ? a.ids : [a.ids])
          .map((x: unknown) => Number(x))
          .filter((x: number) => Number.isInteger(x) && x > 0)
          .slice(0, 20);
        if (!ids.length) {
          return { content: [{ type: "text", text: "Provide ids (from project_context, recall, or related)." }] };
        }
        const parts: string[] = [];
        for (const id of ids) {
          const m = memoryById(id);
          parts.push(m ? `#${id} [${m.kind}] ${m.content}` : `#${id} not found`);
        }
        const text = parts.join("\n\n");
        touchMemories(ids);
        recordContextServed("get_memory", null, text.length);
        return { content: [{ type: "text", text }] };
      }
      case "related": {
        let memId = Number(a.id || 0);
        if (!memId && a.query) {
          const eprov = await getEmbedProvider();
          const qEmb = await eprov.embed(String(a.query));
          const hits = searchMemories(String(a.query), { limit: 1, embedModel: eprov.embedModel }, qEmb);
          memId = hits[0]?.id ?? 0;
        }
        if (!memId) {
          return { content: [{ type: "text", text: "Memory not found. Call recall first to get an id, or include a query." }] };
        }
        const me = memoryById(memId);
        const rel = relatedMemories(memId, 8);
        if (!rel.length) {
          return { content: [{ type: "text", text: `Memory has no related connections (id ${memId}).` }] };
        }
        const head = me ? `Source memory (${me.id}): ${me.content}\n\nConnected memories:\n` : `Connected memories (id ${memId}):\n`;
        const text = head + rel
          .map((r) => `- [${r.linkKind}] (id ${r.memory.id}) ${r.memory.content}`)
          .join("\n");
        return { content: [{ type: "text", text }] };
      }
      case "remember": {
        const kinds = ["fact", "decision", "task_done", "task_pending", "error_fixed", "preference", "context"];
        const kind = kinds.includes(a.kind) ? a.kind : "context";
        const content = String(a.content || "").trim();
        if (!content) {
          return { content: [{ type: "text", text: "content is empty." }] };
        }
        const project = String(a.project || "");
        const resolved = resolveProject(project);
        const projectId = resolved
          ? resolved.id
          : project && project !== "_unknown"
            ? // Hanya terima sebagai kandidat path bila bentuknya memang path —
              // nama proyek polos di-resolve jadi <cwd>/<nama> yang menyesatkan.
              ensureProject(projectSlugFromCwd(project), looksLikePath(project) ? project : undefined)
            : null;
        const eprov = await getEmbedProvider();
        const embedding = await eprov.embed(content);
        const res = addMemoryWithDedupe({
          projectId,
          kind,
          content,
          importance: Math.min(1, Math.max(0, Number(a.importance) || 0.5)),
          createdAt: Date.now(),
          lastAccessed: 0,
          accessCount: 0,
          sourceTool: "mcp",
          embedding,
          status: effectiveStatus(),
          origin: "user",
          embedModel: eprov.embedModel,
        });
        // Smart remember:laporkan apa yang sebenarnya terjadi (ADD/UPDATE/NOOP).
        const text = res.updated
          ? `Memory updated (replaced content of #${res.updated}): [${kind}] ${content}`
          : res.inserted
            ? `Memory saved: [${kind}] ${content}`
            : `Merged into existing memory #${res.mergedInto} (importance raised)`;
        return { content: [{ type: "text", text }] };
      }
      case "update_memory": {
        const id = Number(a.id || 0);
        if (!id) {
          return { content: [{ type: "text", text: "Provide the memory id (from recall)." }] };
        }
        const existing = memoryById(id);
        if (!existing) {
          return { content: [{ type: "text", text: `No memory with id ${id}.` }] };
        }
        const kinds = ["fact", "decision", "task_done", "task_pending", "error_fixed", "preference", "context"];
        const patch: { content?: string; kind?: string; importance?: number; embedding?: number[]; embedModel?: string } = {};
        if (a.content !== undefined) {
          const content = String(a.content || "").trim();
          if (!content) {
            return { content: [{ type: "text", text: "Replacement content would be empty." }] };
          }
          patch.content = content;
        }
        if (a.kind !== undefined) {
          if (!kinds.includes(String(a.kind))) {
            return { content: [{ type: "text", text: `Unknown kind "${a.kind}".` }] };
          }
          patch.kind = String(a.kind);
        }
        if (a.importance !== undefined) {
          patch.importance = Math.min(1, Math.max(0, Number(a.importance) || 0));
        }
        if (patch.content) {
          // Konten berubah → vektor lama basi; re-embed agar recall semantik tetap benar.
          const eprov = await getEmbedProvider();
          const emb = await eprov.embed(patch.content);
          if (emb && emb.length) {
            patch.embedding = emb;
            patch.embedModel = eprov.embedModel;
          }
        }
        if (!Object.keys(patch).length) {
          return { content: [{ type: "text", text: "Nothing to update — pass content, kind, or importance." }] };
        }
        const ok = updateMemory(id, patch);
        if (ok) emitEvent("memory", { kind: patch.kind ?? existing.kind });
        return {
          content: [{
            type: "text",
            text: ok
              ? `Memory ${id} updated: [${patch.kind ?? existing.kind}] ${patch.content ?? existing.content}`
              : "Update failed.",
          }],
        };
      }
      case "forget": {
        const id = Number(a.id || 0);
        if (id) {
          const existing = memoryById(id);
          if (!existing) {
            return { content: [{ type: "text", text: `No memory with id ${id}.` }] };
          }
          const ok = deleteMemory(id);
          if (ok) emitEvent("memory", { kind: "forget" });
          return {
            content: [{
              type: "text",
              text: ok
                ? `Memory ${id} deleted: "${existing.content.replace(/\s+/g, " ").slice(0, 120)}"`
                : "Delete failed.",
            }],
          };
        }
        const query = String(a.query || "").trim();
        if (!query) {
          return { content: [{ type: "text", text: "Provide a memory id, or a query to find the memory to forget." }] };
        }
        const eprov = await getEmbedProvider();
        const qEmb = await eprov.embed(query);
        const hits = searchMemories(query, { limit: 3, embedModel: eprov.embedModel }, qEmb);
        if (!hits.length) {
          return { content: [{ type: "text", text: "No matching memory to forget." }] };
        }
        const top = hits[0];
        // Hapus langsung hanya bila cocoknya yakin; kalau ragu, minta id eksplisit
        // agar agent tidak menghapus memori yang salah.
        if (top.score >= 0.45) {
          const ok = deleteMemory(top.id);
          if (ok) emitEvent("memory", { kind: "forget" });
          return {
            content: [{
              type: "text",
              text: ok
                ? `Deleted (id ${top.id}, score ${top.score.toFixed(2)}): "${top.content.replace(/\s+/g, " ").slice(0, 120)}"`
                : "Delete failed.",
            }],
          };
        }
        const list = hits
          .map((h) => `- id ${h.id} (score ${h.score.toFixed(2)}) [${h.kind}] ${h.content.replace(/\s+/g, " ").slice(0, 100)}`)
          .join("\n");
        return {
          content: [{
            type: "text",
            text: `No confident match (best score ${top.score.toFixed(2)}). Candidates:\n${list}\nCall forget again with the exact id to delete.`,
          }],
        };
      }
      default:
        return { content: [{ type: "text", text: `Tool tidak dikenal: ${name}` }] };
    }
  });

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
