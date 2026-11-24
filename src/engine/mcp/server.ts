import { logRetrieval } from "../retrieve/inspector";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ensureDb } from "../ingest/manager";
import { searchMemories, projectContext, touchMemories } from "../retrieve/search";
import { ensureProject, memoryById, effectiveStatus, getDb, getSetting, resolveProject, updateMemory, deleteMemory } from "../store/db";
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

const KINDS = ["fact", "decision", "task_done", "task_pending", "error_fixed", "preference", "context"];
const RO = { readOnlyHint: true, openWorldHint: false };

/** "lite" = recall, project_context, remember (about a third of the tokens).
 * Chosen with MEMORIA_MCP_TOOLS=lite in the MCP client config, or the
 * `mcpTools` setting; default "full". */
export function toolset(): "full" | "lite" {
  const env = String(process.env.MEMORIA_MCP_TOOLS || "").toLowerCase();
  if (env === "lite" || env === "full") return env;
  try {
    return getSetting("mcpTools", "full") === "lite" ? "lite" : "full";
  } catch {
    return "full";
  }
}

/** Default output caps (characters) per tool; `maxChars` overrides. */
export const DEFAULT_CAPS: Record<string, number> = {
  recall: 4000,
  project_context: 3000,
  build_context: 4000,
  file_context: 2500,
  get_memory: 8000,
  related: 3000,
};

export function capText(text: string, tool: string, maxChars?: unknown): string {
  const n = Number(maxChars) > 0 ? Number(maxChars) : DEFAULT_CAPS[tool] || 0;
  if (!n || text.length <= n) return text;
  return text.slice(0, n - 1) + `…\n(truncated at ${n} chars; pass maxChars or use get_memory for full text)`;
}

export function toolList(mode: "full" | "lite"): Array<Record<string, unknown>> {
  const recall = {
    name: "recall",
    annotations: { title: "Recall memories", ...RO },
    description: "Search memories of earlier work (facts, decisions, tasks, fixed errors) across all AI tools. Call at session start.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question or keywords" },
        project: { type: "string", description: "Optional project path or name" },
        limit: { type: "number", default: 8 },
        ...(mode === "full"
          ? {
              maxChars: { type: "number", description: "Cap the result (default 4000)" },
              mode: { type: "string", enum: ["full", "index"], default: "full", description: "index = one line per hit; details via get_memory" },
            }
          : {}),
      },
      required: ["query"],
    },
  };
  const projectContext = {
    name: "project_context",
    annotations: { title: "Project context", ...RO },
    description:
      mode === "full"
        ? "Latest decisions, open tasks and done work of a project. Default index mode: one line per memory with its id (get_memory for full text)."
        : "Latest decisions, open tasks and done work of a project.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project path or name" },
        limit: { type: "number", default: 10 },
        ...(mode === "full" ? { mode: { type: "string", enum: ["index", "full"], default: "index" } } : {}),
      },
      required: ["project"],
    },
  };
  const remember = {
    name: "remember",
    annotations: { title: "Remember", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    description: "Store a decision, fact, preference or task so every AI tool knows it.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KINDS },
        content: { type: "string", description: "Short and dense" },
        project: { type: "string", description: "Optional project path or name" },
        ...(mode === "full" ? { importance: { type: "number", default: 0.5, description: "0..1" } } : {}),
      },
      required: ["kind", "content"],
    },
  };
  if (mode === "lite") return [recall, projectContext, remember];
  return [
    recall,
    projectContext,
    {
      name: "file_context",
      annotations: { title: "File context", ...RO },
      description: "Before editing a file: known errors, decisions, tasks and preferences that mention it.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, project: { type: "string" }, limit: { type: "number", default: 8 } },
        required: ["path"],
      },
    },
    {
      name: "get_memory",
      annotations: { title: "Get memories", ...RO },
      description: "Full text of memories by id (ids from recall, project_context, related).",
      inputSchema: { type: "object", properties: { ids: { type: "array", items: { type: "number" }, description: "Max 20" } }, required: ["ids"] },
    },
    remember,
    {
      name: "related",
      annotations: { title: "Related memories", ...RO },
      description: "Memories linked to one memory (by id, or the best match for a query).",
      inputSchema: { type: "object", properties: { id: { type: "number" }, query: { type: "string" } } },
    },
    {
      name: "update_memory",
      annotations: { title: "Update memory", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      description: "Correct a memory by id: new content (re-embedded), kind or importance.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "number" }, content: { type: "string" }, kind: { type: "string", enum: KINDS }, importance: { type: "number" } },
        required: ["id"],
      },
    },
    {
      name: "forget",
      annotations: { title: "Forget memory", readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
      description: "Delete a wrong or stale memory by id, or by query (a confident match is deleted, otherwise candidates are listed).",
      inputSchema: { type: "object", properties: { id: { type: "number" }, query: { type: "string" } } },
    },
    {
      name: "build_context",
      annotations: { title: "Build context block", ...RO },
      description: "One ready-to-use block for a project: brief, key memories, optional query matches and relations.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, query: { type: "string" }, maxChars: { type: "number", default: 4000 } },
        required: ["project"],
      },
    },
  ];
}

export function createMcpServer(): Server {
  ensureDb();
  const server = new Server(
    { name: "memoria", version: appVersion() },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolList(toolset()) }));

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
          logRetrieval("recall", projRec?.id ?? null, query, [], 0);
          return {
            content: [{ type: "text", text: "No matching memories. This is a fresh session - proceed with the user's task as usual." }],
          };
        }
        // PR-M: budget token — agent bisa membatasi panjang blok konteks agar
        // tidak melampaui context window-nya (default: tanpa batas).
        const cap = (s: string): string => capText(s, "recall", a.maxChars);
        const full = results
          .map(
            (r) =>
              `[${r.kind}] (id ${r.id}, ${r.projectSlug ?? "global"}, ${r.sourceTool}, importance ${r.importance.toFixed(2)}${r.superseded ? ", SUPERSEDED by a newer decision" : ""}${r.stale ? ", stale: the files it names are gone" : ""}${r.fromEvent ? ", from event" : ""})\n${r.content}`
          )
          .join("\n\n");
        if (a.mode === "index") {
          const idx = cap(indexText(results));
          recordContextServed("recall", projRec?.id ?? null, idx.length, full.length);
          logRetrieval("recall", projRec?.id ?? null, query, results.map((r) => ({ id: r.id, score: r.score })), idx.length);
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
        logRetrieval("recall", projRec?.id ?? null, query, results.map((r) => ({ id: r.id, score: r.score })), withRel.length);
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
        const servedIds: number[] = [];
        const block = buildContextBlock({
          servedIds,
          project,
          query: a.query ? String(a.query) : undefined,
          limit: Number(a.limit || 12),
          maxChars: Number(a.maxChars || DEFAULT_CAPS.build_context),
          embedModel: eprov?.embedModel,
          queryEmbedding: qEmb,
        });
        const bcProject = resolveProject(project)?.id ?? null;
        recordContextServed("build_context", bcProject, block.length);
        logRetrieval("build_context", bcProject, a.query ? String(a.query) : "", servedIds.map((id) => ({ id })), block.length);
        return { content: [{ type: "text", text: block }] };
      }
      case "project_context": {
        const proj = resolveProject(String(a.project || ""));
        const results = proj ? projectContext(proj.slug, Number(a.limit || 10)) : [];
        if (!results.length) {
          logRetrieval("project_context", proj?.id ?? null, "", [], 0);
          return { content: [{ type: "text", text: `No memories stored for project "${a.project}".` }] };
        }
        const full = capText(
          results.map((r) => `[${r.kind}] ${r.content}`).join("\n\n"),
          "project_context"
        );
        if (a.mode === "full") {
          recordContextServed("project_context", proj?.id ?? null, full.length);
          logRetrieval("project_context", proj?.id ?? null, "", results.map((r) => ({ id: r.id })), full.length);
          return { content: [{ type: "text", text: full }] };
        }
        const idx = capText(indexText(results), "project_context");
        recordContextServed("project_context", proj?.id ?? null, idx.length, full.length);
        logRetrieval("project_context", proj?.id ?? null, "", results.map((r) => ({ id: r.id })), idx.length);
        return { content: [{ type: "text", text: idx }] };
      }
      case "file_context": {
        const p = String(a.path || "").trim();
        if (!p) return { content: [{ type: "text", text: "path is required." }] };
        const hits = fileContext(p, { project: a.project ? String(a.project) : undefined, limit: Number(a.limit || 8) });
        if (!hits.length) {
          logRetrieval("file_context", null, p, [], 0);
          return { content: [{ type: "text", text: `No memories mention ${p}.` }] };
        }
        const text = capText(`Known about ${p}:\n` + hits.map((h) => `- #${h.id} [${h.kind}] ${h.content.replace(/\s+/g, " ")}`).join("\n"), "file_context");
        touchMemories(hits.map((h) => h.id));
        recordContextServed("file_context", hits[0].projectId, text.length);
        logRetrieval("file_context", hits[0].projectId, p, hits.map((h) => ({ id: h.id })), text.length);
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
        const text = capText(parts.join("\n\n"), "get_memory");
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
        const text = capText(head + rel.map((r) => `- [${r.linkKind}] (id ${r.memory.id}) ${r.memory.content}`).join("\n"), "related");
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
