import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { getApiToken, isAuthorized, safeEqual, tokenCookieHeader } from "./auth";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "./config";
import { scanAll, stats, ensureDb } from "./ingest/manager";
import { searchMemories, projectContext } from "./retrieve/search";
import { allMemories, recentProjects, readMemoriesLite, insertMemory, ensureProject, deleteMemory, projectSlugById, projectRecord, getDb, getSetting, setSetting, listArchived, archiveMemory, updateMemory, archiveStaleEligibles, listMemoriesPage, approveMemory, effectiveStatus, countMemories, countDraft, countArchived, entitiesForMemory, tagsForMemory, allTags, memoriesByTag, resolveProject, memoryById } from "./store/db";
import { looksLikePath, projectSlugFromCwd } from "./ingest/util";
import { ollamaAvailable } from "./extract/ollama";
import { getEmbedProvider, engineStatus } from "./extract/provider";
import { extractQueue } from "./extract/extractor";
import { addMemoryWithDedupe } from "./extract/dedupe";
import { generateHandoff, injectHandoff, injectHandoffAll, removeInjectAll } from "./handoff";
import { backupDb, pruneArchivedBackups, listBackups, restoreBackup } from "./store/backup";
import { registerIntegration, integrationStatus } from "./integrate";
import { runGitLog } from "./git";
import { graphSnapshot, relatedMemories, rebuildAllLinks } from "./graph";
import { countOpen } from "./extract/tasklife";
import { addListener, removeListener, emitEvent } from "./events";
import { runGitStatus } from "./git";
import { withTx } from "./store/tx";

// Versi engine dari package.json di root — dipakai chip versi dashboard
// (dulu hardcoded, jadi selalu basi setiap rilis).
const APP_VERSION: string = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")).version || "";
  } catch {
    return "";
  }
})();

function numParam(v: string | null | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function sendJson(res: ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  // CORS hanya untuk origin lokal — situs eksternal tidak boleh membaca respons API.
  const origin = String(res.req?.headers?.origin || "");
  const allowOrigin = isLocalHost(origin) ? origin : "";
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin, Vary: "Origin" } : {}),
  });
  res.end(body);
}

function isLocalHost(hostOrUrl: string): boolean {
  if (!hostOrUrl) return false;
  let hostname = hostOrUrl;
  if (hostOrUrl.includes("://")) {
    try {
      hostname = new URL(hostOrUrl).hostname;
    } catch {
      return false;
    }
  }
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

function enrichMemory(m: any): any {
  if (m.id == null) return m;
  try {
    return { ...m, entities: entitiesForMemory(Number(m.id)), tags: tagsForMemory(Number(m.id)) };
  } catch {
    return m;
  }
}

// M8 (audit): endpoint berat dilindungi in-flight guard per-path (409).

// M8 (audit): endpoint berat dilindungi in-flight guard per-path (409).
const busyEndpoints = new Set<string>();

// L6 (audit): logo 893KB dibaca sync tiap request — cache sekali baca.
let logoCache: Buffer | null = null;

// M15 (audit): body dibatasi 10 MB — dulu concatenation tanpa batas, dan
// request yang di-abort client membuat promise tidak pernah resolve.
const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    let size = 0;
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.destroy();
        resolve({});
        return;
      }
      raw += c;
    });
    req.on("end", () =>
      finish(() => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      })
    );
    req.on("error", () => finish(() => resolve({})));
    req.on("close", () => finish(() => resolve({})));
  });
}

// Dashboard/palette/quick dilayani dari sini agar UI tidak perlu hardcode port:
// fetch("/api/...") same-origin bekerja di port berapa pun hasil config.
const WEB_DIR = path.resolve(__dirname, "..", "..", "web");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveStatic(url: URL, res: ServerResponse): boolean {
  if (url.pathname.startsWith("/api/")) return false;
  // Aset logo tinggal di root aplikasi (dipakai juga ikon tray/app) —
  // layankan path tetap ini tanpa membuka direktori lain.
  if (url.pathname === "/logo.png") {
    try {
      // L6 (audit): logo 893KB dibaca sync tiap request — cache sekali baca.
      if (!logoCache) {
        const logo = path.resolve(WEB_DIR, "..", "logo.png");
        logoCache = fs.readFileSync(logo);
      }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=3600" });
      res.end(logoCache);
      return true;
    } catch {
      sendJson(res, 404, { error: "not found" });
      return true;
    }
  }
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const file = path.resolve(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR + path.sep)) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }
  try {
    const data = fs.readFileSync(file);
    const mime = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    // HTML/JS/CSS tanpa cache agar update UI selalu terlihat; gambar boleh cache.
    const cache = mime.startsWith("image/") ? "max-age=3600" : "no-cache";
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": cache });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
  return true;
}

export function startHttpServer(): Promise<void> {
  ensureDb();
  const port = getConfig().httpPort;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    try {
      // --- Pemeriksaan keamanan (server hanya boleh diakses dari mesin ini) ---
      // 1) Host header: proteksi DNS-rebinding (host asing = tolak).
      const hostName = String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
      if (hostName && !isLocalHost(hostName)) {
        sendJson(res, 403, { error: "forbidden host" });
        return;
      }
      // 2) Origin asing ditolak untuk SEMUA method (dulu hanya non-GET). Browser
      //    selalu mengirim Origin pada fetch lintas situs; tanpa ini situs luar
      //    bisa memicu GET berefek samping (mis. /api/export) ke localhost.
      if (req.headers.origin && !isLocalHost(String(req.headers.origin))) {
        sendJson(res, 403, { error: "forbidden origin" });
        return;
      }
      // 3) API token (on by default, see auth.ts). One-time login link
      //    /?token=… stores an HttpOnly cookie and redirects to the dashboard.
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
        const given = url.searchParams.get("token") || "";
        if (safeEqual(given, getApiToken())) {
          res.writeHead(302, { "Set-Cookie": tokenCookieHeader(given), Location: "/", "Cache-Control": "no-store" });
          res.end();
          return;
        }
        sendJson(res, 401, { error: "invalid token" });
        return;
      }
      // Static assets (HTML/JS/CSS/images) contain no data and stay public so
      // the dashboard can explain how to sign in; /api and /mcp need the token.
      const needsAuth = url.pathname.startsWith("/api/") || url.pathname === "/mcp";
      if (needsAuth && req.method !== "OPTIONS" && !isAuthorized(req)) {
        sendJson(res, 401, { error: "unauthorized: open the dashboard link printed by `memoria server`, or send the x-memoria-token header", auth: true });
        return;
      }
      // M8 (audit): endpoint berat dilindungi in-flight guard per-path —
      // dua window/curl/double-klik tidak boleh menjalankan scan/purge/
      // konsolidasi yang sama bersamaan (409 sampai selesai).
      const HEAVY: Record<string, string> = {
        "/api/scan:POST": "scan",
        "/api/consolidate:POST": "consolidate",
        "/api/drafts/clean-noise:POST": "clean-noise",
        "/api/graph/rebuild:POST": "graph-rebuild",
        "/api/tags/rebuild:POST": "tags-rebuild",
        "/api/digest/generate:POST": "digest",
        "/api/import/markdown:POST": "import-md",
        "/api/memories/purge:POST": "purge",
      };
      const heavyKey = HEAVY[url.pathname + ":" + req.method];
      if (heavyKey) {
        if (busyEndpoints.has(heavyKey)) {
          sendJson(res, 409, { error: "already running" });
          return;
        }
        busyEndpoints.add(heavyKey);
        res.on("finish", () => busyEndpoints.delete(heavyKey));
      }
      // PR-K: MCP over HTTP (streamable) — jembatan antar-AI di port yang
      // sama. Hook SETELAH guard host/origin/token: mewarisi keamanan API.
      // Transport membaca body mentah sendiri — JANGAN pre-parse di sini.
      if (url.pathname === "/mcp") {
        const { handleMcpHttp } = await import("./mcp/http");
        await handleMcpHttp(req, res);
        return;
      }
      if (req.method === "OPTIONS") {
        const origin = String(req.headers.origin || "");
        res.writeHead(204, {
          ...(isLocalHost(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
          "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE",
          "Access-Control-Allow-Headers": "Content-Type,x-memoria-token",
        });
        res.end();
        return;
      }
      if (req.method === "GET" && serveStatic(url, res)) return;
      if (url.pathname === "/api/stats" && req.method === "GET") {
        const s = stats();
        const ollama = await ollamaAvailable();
        const engine = await engineStatus();
        const cfg = getConfig();
        const recent = readMemoriesLite("WHERE archived = 0 AND status = 'active' ORDER BY created_at DESC LIMIT 8")
          
          .map((m) => ({ id: m.id, kind: m.kind, content: m.content, importance: m.importance, createdAt: m.createdAt, sourceTool: m.sourceTool, projectSlug: projectSlugById(m.projectId) }))
          .map(enrichMemory);
        sendJson(res, 200, {
          ...s,
          version: APP_VERSION,
          ollamaOnline: ollama,
          engine,
          setup: {
            toolsDetected: s.perTool.length,
            engineLabel: engine.extract,
            llmReady: !engine.extract.startsWith("Heuristics"),
            memoriesCount: s.memories,
          },
          rssMB: Math.round(process.memoryUsage().rss / 1048576),
          recent,
          config: { dataDir: cfg.dataDir, ollamaExtractModel: cfg.ollamaExtractModel, ollamaEmbedModel: cfg.ollamaEmbedModel, httpPort: cfg.httpPort },
        });
      } else if (url.pathname === "/api/scan" && req.method === "POST") {
        const logLines: string[] = [];
        const results = await scanAll((m) => logLines.push(m));
        await extractQueue(true);
        sendJson(res, 200, { results, log: logLines });
      } else if (url.pathname === "/api/search" && req.method === "GET") {
        const q = url.searchParams.get("q") || "";
        const project = url.searchParams.get("project") || undefined;
        const kind = url.searchParams.get("kind") || undefined;
        const limit = Number(url.searchParams.get("limit") || 10);
        const eprov = await getEmbedProvider();
        const qEmb = await eprov.embed(q);
        const since = numParam(url.searchParams.get("since"), 0, 0, Date.now());
        const hits = searchMemories(q, { limit, projectSlug: project, kind, embedModel: eprov.embedModel, since }, qEmb).map(enrichMemory);
        sendJson(res, 200, { hits });
      } else if (url.pathname === "/api/project" && req.method === "GET") {
        const project = url.searchParams.get("slug") || "";
        sendJson(res, 200, { hits: projectContext(project) });
      } else if (url.pathname === "/api/projects" && req.method === "GET") {
        sendJson(res, 200, { projects: recentProjects(20) });
      } else if (url.pathname === "/api/memories" && req.method === "GET") {
        // Pustaka lengkap dengan pagination — param `status` kini benar-benar dihormati.
        const status = url.searchParams.get("status") || "active";
        const limit = numParam(url.searchParams.get("limit"), 50, 1, 200);
        const offset = numParam(url.searchParams.get("offset"), 0, 0, 1e9);
        const since = Math.max(0, Number(url.searchParams.get("since") || 0) || 0);
        const { memories: mems, total } = listMemoriesPage(status, limit, offset, since);
        const page = mems
          .map((m) => ({ id: m.id, kind: m.kind, content: m.content, importance: m.importance, createdAt: m.createdAt, sourceTool: m.sourceTool, status: m.status, projectSlug: projectSlugById(m.projectId) }))
          .map(enrichMemory);
        sendJson(res, 200, {
          memories: page,
          total,
          offset,
          limit,
          hasMore: offset + page.length < total,
          counts: {
            active: countMemories(),
            draft: countDraft(),
            archived: countArchived(),
          },
        });
      } else if (url.pathname === "/api/memories/one" && req.method === "GET") {
        // Satu memori lengkap (untuk modal edit dari konteks mana pun)
        const id = Number(url.searchParams.get("id") || 0);
        const { memoryById } = await import("./store/db");
        const m = memoryById(id);
        if (!m) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, {
          memory: { id: m.id, kind: m.kind, content: m.content, importance: m.importance, createdAt: m.createdAt, sourceTool: m.sourceTool, projectSlug: projectSlugById(m.projectId), tags: tagsForMemory(id), status: m.status || "active" },
        });
      } else if (url.pathname === "/api/memories/list" && req.method === "GET") {
        // Pagination F1C: bentuk respons menyamai /api/memories.
        const status = url.searchParams.get("status") || "active";
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
        const listSince = numParam(url.searchParams.get("since"), 0, 0, Date.now());
        const { memories, total } = listMemoriesPage(status, limit, offset, listSince);
        const page = memories
          .map((m) => ({ ...m, embedding: undefined, projectSlug: projectSlugById(m.projectId) }))
          .map(enrichMemory);
        sendJson(res, 200, { memories: page, total, offset, limit, hasMore: offset + page.length < total });
      } else if (url.pathname === "/api/memories/approve" && req.method === "POST") {
        const body = await readBody(req);
        const approveId = Number(body.id || 0);
        const ok = approveMemory(approveId);
        // F3: event notifikasi (webhook) — satu memori di-approve.
        if (ok) {
          const m = memoryById(approveId);
          if (m) emitEvent("memory_approved", { count: 1, items: [{ kind: m.kind, project: projectSlugById(m.projectId), content: m.content }] });
        }
        sendJson(res, ok ? 200 : 404, { ok });
      } else if (url.pathname === "/api/backups" && req.method === "GET") {
        sendJson(res, 200, { backups: listBackups() });
      } else if (url.pathname === "/api/backup/restore" && req.method === "POST") {
        const body = await readBody(req);
        const r = restoreBackup(String(body.path || ""));
        if (r.ok) {
          const { invalidateVecIndex } = await import("./vecfind");
          const { invalidateCentrality } = await import("./retrieve/search");
          const { resetProjectMemo } = await import("./store/db");
          invalidateVecIndex();
          invalidateCentrality();
          resetProjectMemo();
        }
        sendJson(res, r.ok ? 200 : 400, r);
      } else if (url.pathname === "/api/project-detail" && req.method === "GET") {
        // Agregat satu panggilan untuk halaman detail proyek.
        const slug = url.searchParams.get("slug") || "";
        const proj = resolveProject(slug);
        if (!proj) { sendJson(res, 404, { error: "project not found" }); return; }
        const rec = projectRecord(proj.slug);
        if (!rec) { sendJson(res, 404, { error: "project not found" }); return; }
        const db = getDb();
        const lastSeen = (db.prepare("SELECT MAX(last_seen) AS m FROM projects WHERE id = ?").get(rec.id) as { m: number | null }).m ?? 0;
        const DAY = 86400000;
        const today = Math.floor(Date.now() / DAY);
        const weekRows = db
          .prepare("SELECT CAST(ts / ? AS INTEGER) AS d, COUNT(*) AS c FROM transcripts WHERE project_id = ? AND ts >= ? GROUP BY d")
          .all(DAY, rec.id, Date.now() - 7 * DAY) as Array<{ d: number; c: number }>;
        const byDay = new Map(weekRows.map((r) => [Number(r.d), r.c]));
        const week: Array<{ day: string; count: number }> = [];
        for (let i = 6; i >= 0; i--) {
          const dd = today - i;
          week.push({ day: new Date(dd * DAY).toISOString().slice(5, 10), count: byDay.get(dd) || 0 });
        }
        const transcripts = (db.prepare("SELECT COUNT(*) AS c FROM transcripts WHERE project_id = ?").get(rec.id) as { c: number }).c;
        const memCount = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND archived = 0 AND status = 'active'").get(rec.id) as { c: number }).c;
        const tasksOpen = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND kind = 'task_pending' AND archived = 0 AND status = 'active' AND COALESCE(resolved_at, 0) = 0").get(rec.id) as { c: number }).c;
        const { listTasks } = await import("./store/db");
        const tasks = listTasks(rec.id, 60);
        const slim = (m: any) => ({ id: m.id, content: m.content, importance: m.importance, createdAt: m.createdAt, resolvedAt: m.resolvedAt, sourceTool: m.sourceTool });
        const git = rec.path && fs.existsSync(rec.path) ? await runGitStatus(rec.path) : null;
        const recentMemories = readMemoriesLite("WHERE project_id = " + rec.id + " AND archived = 0 AND status = 'active' ORDER BY created_at DESC LIMIT 8")
          .map((m) => ({ id: m.id, kind: m.kind, content: m.content, importance: m.importance, createdAt: m.createdAt, sourceTool: m.sourceTool }));
        // Heuristic mode parks results in the review queue — surface them so a
        // project with only drafts doesn't read as "empty".
        const draftCount = (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND archived = 0 AND status = 'draft'").get(rec.id) as { c: number }).c;
        const drafts = db
          .prepare("SELECT id, content, created_at AS createdAt, source_tool AS sourceTool FROM memories WHERE project_id = ? AND archived = 0 AND status = 'draft' ORDER BY created_at DESC LIMIT 3")
          .all(rec.id) as Array<{ id: number; content: string; createdAt: number; sourceTool: string }>;
        sendJson(res, 200, {
          project: { slug: rec.slug, name: rec.name, path: rec.path },
          stats: { transcripts, memories: memCount, tasksOpen, lastSeen, drafts: draftCount },
          draftCount,
          drafts,
          week, git, tasks: { open: tasks.open.map(slim), done: tasks.done.map(slim) },
          recentMemories,
          brain: await (async () => {
            if (!rec.path) return null;
            const { brainPath, parseBrain } = await import("./team/brain");
            const f = brainPath(rec.path);
            const exists = fs.existsSync(f);
            return { export: getSetting(`brain:${rec.slug}:export`, "0") === "1", exists, entries: exists ? parseBrain(fs.readFileSync(f, "utf8")).length : 0 };
          })(),
        });
      } else if (url.pathname === "/api/projects/brain" && req.method === "POST") {
        // Opt a project in/out of .memoria/brain.md; opting in exports now.
        const body = await readBody(req);
        const rec = projectRecord(String(body.slug || ""));
        if (!rec) {
          sendJson(res, 404, { error: "project not found" });
          return;
        }
        const brain = await import("./team/brain");
        brain.setBrainExport(rec.slug, !!body.export);
        if (!body.export) {
          sendJson(res, 200, { ok: true, export: false });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, export: true, ...brain.exportBrain(rec.slug) });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      } else if (url.pathname === "/api/tasks" && req.method === "GET") {
        const slug = url.searchParams.get("slug") || "";
        const proj = slug ? resolveProject(slug) : null;
        const { listTasks } = await import("./store/db");
        const { open, done } = listTasks(proj ? proj.id : null, 300);
        const slim = (m: any) => ({ id: m.id, content: m.content, importance: m.importance, createdAt: m.createdAt, resolvedAt: m.resolvedAt, sourceTool: m.sourceTool, projectSlug: projectSlugById(m.projectId) });
        sendJson(res, 200, { open: open.map(slim), done: done.map(slim), countOpen: open.length, project: proj?.slug ?? null });
      } else if (url.pathname === "/api/tasks/resolve" && req.method === "POST") {
        const body = await readBody(req);
        const { setTaskResolved } = await import("./store/db");
        const ok = setTaskResolved(Number(body.id || 0), body.resolved !== false);
        if (ok) emitEvent("tasks", { id: Number(body.id || 0), resolved: body.resolved !== false });
        sendJson(res, ok ? 200 : 404, { ok });
      } else if (url.pathname === "/api/remember" && req.method === "POST") {
        const body = await readBody(req);
        // M6 (audit): validasi konten — dulu empty/multi-MB langsung disimpan.
        const contentRaw = String(body.content || "").trim();
        if (!contentRaw) {
          sendJson(res, 400, { error: "content kosong" });
          return;
        }
        if (contentRaw.length > 32768) {
          sendJson(res, 400, { error: "content terlalu panjang (maks 32768 karakter)" });
          return;
        }
        const kind = ["fact", "decision", "task_done", "task_pending", "error_fixed", "preference", "context"].includes(body.kind) ? body.kind : "context";
        // Jangan slugify sebelum ensureProject — path mentah dibutuhkan agar
        // proyek yang sama dari tool berbeda bisa di-merge (identitas kanonik).
        const rawProject = String(body.project || "").trim();
        const projectId = rawProject && rawProject !== "_unknown"
          ? ensureProject(projectSlugFromCwd(rawProject), looksLikePath(rawProject) ? rawProject : undefined)
          : null;
        const eprov = await getEmbedProvider();
        const embedding = await eprov.embed(String(body.content || ""));
        addMemoryWithDedupe({
          projectId,
          kind,
          content: contentRaw,
          importance: Math.min(1, Math.max(0, Number(body.importance) || 0.5)),
          createdAt: Date.now(),
          lastAccessed: 0,
          accessCount: 0,
          sourceTool: "dashboard",
          embedding,
          status: effectiveStatus(),
          origin: "user",
          embedModel: eprov.embedModel,
        });
        sendJson(res, 200, { ok: true });
      } else if (url.pathname === "/api/memories" && req.method === "DELETE") {
        const id = Number(url.searchParams.get("id") || 0);
        const ok = deleteMemory(id);
        sendJson(res, ok ? 200 : 404, { ok });
      } else if (url.pathname === "/api/memories" && req.method === "PUT") {
        const body = await readBody(req);
        const id = Number(body.id || 0);
        // Pindah proyek: raw string diselesaikan seperti alur remember
        let projectId: number | null | undefined = undefined;
        if (body.project !== undefined) {
          const raw = String(body.project || "").trim();
          if (!raw || raw === "_unknown") projectId = null;
          else {
            const resolved = resolveProject(raw);
            projectId = resolved ? resolved.id : ensureProject(projectSlugFromCwd(raw), looksLikePath(raw) ? raw : undefined);
          }
        }
        const ok = updateMemory(id, {
          content: body.content !== undefined ? String(body.content) : undefined,
          kind: body.kind !== undefined ? String(body.kind) : undefined,
          importance: body.importance !== undefined ? Math.min(1, Math.max(0, Number(body.importance))) : undefined,
          projectId,
        });
        if (ok && Array.isArray(body.tags)) {
          const { replaceMemoryTags } = await import("./store/db");
          replaceMemoryTags(id, body.tags.map((t: unknown) => String(t)));
        }
        sendJson(res, ok ? 200 : 404, { ok });
      } else if (url.pathname === "/api/memories/batch" && req.method === "POST") {
        // Aksi massal untuk antrian kurasi: approve / delete / archive
        const body = await readBody(req);
        const ids = (Array.isArray(body.ids) ? body.ids : []).map((x: unknown) => Number(x)).filter((x: number) => x > 0);
        const action = String(body.action || "");
        let affected = 0;
        for (const id of ids) {
          if (action === "approve") affected += approveMemory(id) ? 1 : 0;
          else if (action === "delete") affected += deleteMemory(id) ? 1 : 0;
          else if (action === "archive") affected += archiveMemory(id, true) ? 1 : 0;
        }
    emitEvent("tasks", { batch: action, affected });
    // F3: notifikasi batch approve = satu notif ringkas berisi jumlah.
    if (action === "approve" && affected > 0) emitEvent("memory_approved", { count: affected, batch: true });
    sendJson(res, 200, { ok: true, affected });
      } else if (url.pathname === "/api/triage" && req.method === "GET") {
        // Status + pratinjau (dry-run) auto-triage Tier 0.
        const { runTriage, triageStatus } = await import("./extract/triage");
        sendJson(res, 200, { status: triageStatus(), preview: runTriage({ dryRun: true }) });
      } else if (url.pathname === "/api/triage" && req.method === "POST") {
        const { runTriage, triageStatus } = await import("./extract/triage");
        const r = runTriage();
        if (r.promoted || r.archived) emitEvent("memory", { triage: r.batch });
        sendJson(res, 200, { ok: true, result: r, status: triageStatus() });
      } else if (url.pathname === "/api/triage/undo" && req.method === "POST") {
        const body = await readBody(req);
        const { undoTriage, triageStatus } = await import("./extract/triage");
        const r = undoTriage(body.batch ? String(body.batch) : undefined);
        if (r.restored) emitEvent("memory", { triageUndo: r.batch });
        sendJson(res, 200, { ok: true, ...r, status: triageStatus() });
      } else if (url.pathname === "/api/drafts/groups" && req.method === "GET") {
        // Inbox berkelompok: proyek × jenis, dengan id untuk aksi massal satu klik.
        const rows = getDb()
          .prepare(
            `SELECT m.id, m.kind, m.project_id AS projectId, COALESCE(p.name, p.slug, '') AS project
             FROM memories m LEFT JOIN projects p ON p.id = m.project_id
             WHERE m.archived = 0 AND m.status = 'draft' ORDER BY m.created_at DESC`
          )
          .all() as Array<{ id: number; kind: string; projectId: number | null; project: string }>;
        const groups = new Map<string, { projectId: number | null; project: string; kind: string; ids: number[] }>();
        for (const r of rows) {
          const key = `${r.projectId ?? "null"}|${r.kind}`;
          if (!groups.has(key)) groups.set(key, { projectId: r.projectId, project: r.project || "(no project)", kind: r.kind, ids: [] });
          groups.get(key)!.ids.push(r.id);
        }
        // Pattern groups: drafts that start the same way ("Jalankan build …",
        // "The test suite …") usually share one fate; offer one-click archive
        // and "always archive drafts like this".
        const contents = getDb()
          .prepare("SELECT id, content FROM memories WHERE archived = 0 AND status = 'draft'")
          .all() as Array<{ id: number; content: string }>;
        const byPrefix = new Map<string, number[]>();
        for (const r of contents) {
          const words = r.content.replace(/[`*_#>\[\]()"']/g, "").trim().split(/\s+/).slice(0, 3);
          if (words.length < 3) continue;
          const key = words.join(" ").toLowerCase();
          if (!byPrefix.has(key)) byPrefix.set(key, []);
          byPrefix.get(key)!.push(r.id);
        }
        const patterns = [...byPrefix.entries()]
          .filter(([, ids]) => ids.length >= 3)
          .map(([pattern, ids]) => ({ pattern, ids }))
          .sort((a, b) => b.ids.length - a.ids.length)
          .slice(0, 12);
        sendJson(res, 200, { groups: [...groups.values()].sort((a, b) => b.ids.length - a.ids.length), patterns, total: rows.length });
      } else if (url.pathname === "/api/drafts/noise-patterns" && req.method === "GET") {
        const { userNoisePatterns } = await import("./extract/triage");
        sendJson(res, 200, { patterns: userNoisePatterns() });
      } else if (url.pathname === "/api/drafts/noise-patterns" && req.method === "POST") {
        const body = await readBody(req);
        const { addUserNoisePattern } = await import("./extract/triage");
        try {
          const r = addUserNoisePattern(String(body.pattern || ""));
          if (r.archived) emitEvent("memory", { triage: r.batch });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      } else if (url.pathname === "/api/drafts/noise-patterns" && req.method === "DELETE") {
        const body = await readBody(req);
        const { removeUserNoisePattern } = await import("./extract/triage");
        sendJson(res, 200, { ok: true, patterns: removeUserNoisePattern(String(body.pattern || "")) });
      } else if (url.pathname === "/api/onboarding" && req.method === "GET") {
        const { detectTools, onboardingStatus } = await import("./onboarding");
        sendJson(res, 200, { status: onboardingStatus(), tools: detectTools() });
      } else if (url.pathname === "/api/onboarding/start" && req.method === "POST") {
        const body = await readBody(req);
        const { startOnboarding, onboardingStatus } = await import("./onboarding");
        const tools = (Array.isArray(body.tools) ? body.tools : []).map((t: unknown) => String(t)).slice(0, 20);
        startOnboarding(tools);
        sendJson(res, 200, { ok: true, status: onboardingStatus() });
      } else if (url.pathname === "/api/onboarding/summary" && req.method === "GET") {
        const { rememberedSummary } = await import("./onboarding");
        sendJson(res, 200, { projects: rememberedSummary(3) });
      } else if (url.pathname === "/api/onboarding/skip" && req.method === "POST") {
        const { markOnboarded } = await import("./onboarding");
        markOnboarded();
        sendJson(res, 200, { ok: true });
      } else if (url.pathname === "/api/file-context" && req.method === "GET") {
        const { fileContext } = await import("./retrieve/filecontext");
        const p = url.searchParams.get("path") || "";
        sendJson(res, 200, { path: p, memories: p ? fileContext(p, { project: url.searchParams.get("project") || undefined }) : [] });
      } else if (url.pathname === "/api/decisions/restore" && req.method === "POST") {
        // Undo a supersession: the decision becomes current again.
        const body = await readBody(req);
        const { restoreDecision } = await import("./extract/supersede");
        const ok = restoreDecision(Number(body.id || 0));
        if (ok) emitEvent("memory", { kind: "decision" });
        sendJson(res, ok ? 200 : 404, { ok });
      } else if (url.pathname === "/api/privacy" && req.method === "GET") {
        // Privacy report: apa yang ditangkap & berapa secret yang disensor.
        const d = getDb();
        const perTool = d.prepare("SELECT tool, COUNT(*) AS c, MAX(ts) AS last FROM transcripts GROUP BY tool ORDER BY c DESC").all();
        const { triageStatus } = await import("./extract/triage");
        sendJson(res, 200, {
          redactedTotal: Number(getSetting("redactedTotal", "0")) || 0,
          cloudEngine: getSetting("extractEngine", "") === "openai" || getSetting("embedEngine", "") === "openai",
          perTool,
          triage: triageStatus(),
        });
      } else if (url.pathname === "/api/memories/archive" && req.method === "POST") {
        const body = await readBody(req);
        const id = Number(body.id || 0);
        const ok = archiveMemory(id, body.archived !== false);
        sendJson(res, ok ? 200 : 404, { ok });
      } else if (url.pathname === "/api/archived" && req.method === "GET") {
        sendJson(res, 200, {
          memories: listArchived().map((m) => ({ ...m, embedding: undefined, projectSlug: projectSlugById(m.projectId) })),
        });
      } else if (url.pathname === "/api/settings" && req.method === "GET") {
        const cfg = getConfig();
        sendJson(res, 200, {
          settings: {
            autoInjectProjectFiles: getSetting("autoInjectProjectFiles", cfg.autoInjectProjectFiles ? "1" : "0"),
            autoStartOllama: getSetting("autoStartOllama", "1"),
            autoBackup: getSetting("autoBackup", "1"),
            autoArchive: getSetting("autoArchive", "1"),
            autoTopics: getSetting("autoTopics", "1"),
            autoConsolidate: getSetting("autoConsolidate", "1"),
            globalPalette: getSetting("globalPalette", "1"),
            reviewMode: getSetting("reviewMode", "0"),
            autoTriage: getSetting("autoTriage", "1"),
            apiTokenRequired: getSetting("apiTokenRequired", "1"),
            weeklyDigest: getSetting("weeklyDigest", "1"),
            autoStartLogin: getSetting("autoStartLogin", "1"),
            shortcutQuick: getSetting("shortcutQuick", "CommandOrControl+Shift+M"),
            shortcutPalette: getSetting("shortcutPalette", "CommandOrControl+Shift+Space"),
            "injectFile:AGENTS.md": getSetting("injectFile:AGENTS.md", "1"),
            "injectFile:CLAUDE.md": getSetting("injectFile:CLAUDE.md", "1"),
            "injectFile:GEMINI.md": getSetting("injectFile:GEMINI.md", "1"),
            extractEngine: getSetting("extractEngine", "auto"),
            embedEngine: getSetting("embedEngine", "auto"),
            openaiProvider: getSetting("openaiProvider", "custom"),
            openaiBaseUrl: getSetting("openaiBaseUrl", ""),
            openaiExtractModel: getSetting("openaiExtractModel", "gpt-4o-mini"),
            openaiEmbedModel: getSetting("openaiEmbedModel", "text-embedding-3-small"),
            openaiHasKey: getSetting("openaiApiKey", "") ? "1" : "0",
            // F3 webhook — secret tidak pernah dibalikkan, hanya penanda ada/tidak.
            notifyDigest: getSetting("notifyDigest", "0"),
            notifyScan: getSetting("notifyScan", "0"),
            notifyApprove: getSetting("notifyApprove", "0"),
            notifyDrafts: getSetting("notifyDrafts", "0"),
            notifyLimit: getSetting("notifyLimit", "0"),
            notifyDraftMin: getSetting("notifyDraftMin", "3"),
            notifyTelegramChat: getSetting("notifyTelegramChat", ""),
            captureExclude: getSetting("captureExclude", ""),
            obsidianVault: getSetting("obsidianVault", ""),
            notifyDiscordHas: getSetting("notifyDiscordUrl", "") ? "1" : "0",
            notifyTelegramHas: getSetting("notifyTelegramToken", "") ? "1" : "0",
            notifyGenericHas: getSetting("notifyGenericUrl", "") ? "1" : "0",
            extractThreshold: getSetting("extractThreshold", "0.3"),
            sources: Object.fromEntries(
              cfg.sources.map((s) => [s.tool, getSetting(`source:${s.tool}:enabled`, s.enabled ? "1" : "0")])
            ),
            sourceLabels: Object.fromEntries(cfg.sources.map((s) => [s.tool, s.label])),
          },
        });
      } else if (url.pathname === "/api/settings" && req.method === "POST") {
        const body = await readBody(req);
        if (body.key === "sync.groupKey") {
          sendJson(res, 400, { error: "sync.groupKey is managed by `memoria sync setup`" });
          return;
        }
        if (body.key && body.value !== undefined) {
          // Secret (API key & webhook) disimpan terenkripsi bila safeStorage
          // tersedia (Keychain/DPAPI); value kosong = hapus.
          const { SECRET_SETTING_KEYS } = await import("./store/secure");
          if (SECRET_SETTING_KEYS.includes(String(body.key))) {
            const { encryptSecret } = await import("./store/secure");
            const v = String(body.value);
            if (!v) {
              setSetting(String(body.key), "");
              sendJson(res, 200, { ok: true, cleared: true });
              return;
            }
            const enc = encryptSecret(v);
            setSetting(String(body.key), enc ?? v);
            sendJson(res, 200, { ok: true, encrypted: !!enc });
            return;
          }
          setSetting(String(body.key), String(body.value));
          sendJson(res, 200, { ok: true });
        } else {
          sendJson(res, 400, { error: "key & value wajib" });
        }
      } else if (url.pathname === "/api/notify/test" && req.method === "POST") {
        // F3: kirim payload tes ke satu platform (bypass toggle event).
        const body = await readBody(req);
        const platform = ["discord", "telegram", "generic"].includes(String(body.platform))
          ? (String(body.platform) as "discord" | "telegram" | "generic")
          : undefined;
        const { sendNotification } = await import("./notify/webhook");
        const results = await sendNotification(
          { event: "scan", title: "Memoria test notification", body: "If you can read this, the webhook is wired up correctly.", details: { test: true } },
          platform
        );
        if (!results.length) {
          sendJson(res, 200, { ok: false, error: "not configured" });
          return;
        }
        const failed = results.filter((r) => !r.ok);
        sendJson(res, 200, failed.length ? { ok: false, error: failed[0].error } : { ok: true, sent: results.map((r) => r.platform) });
      } else if (url.pathname === "/api/handoff" && req.method === "GET") {
        const proj = resolveProject(url.searchParams.get("slug") || "");
        const md = await generateHandoff(proj ? proj.slug : "");
        sendJson(res, 200, { text: md });
      } else if (url.pathname === "/api/resume" && req.method === "GET") {
        // Prompt lanjutan ringkas siap-paste — plan B bila injeksi file tidak terbaca tool.
        const { generateResumePrompt } = await import("./handoff");
        const proj = resolveProject(url.searchParams.get("slug") || "");
        const text = await generateResumePrompt(proj ? proj.slug : "");
        sendJson(res, 200, { text });
      } else if (url.pathname === "/api/handoff" && req.method === "POST") {
        const body = await readBody(req);
        const proj = resolveProject(String(body.slug || ""));
        const slug = proj ? proj.slug : String(body.slug || "");
        if (body.file) {
          // Mode lama: satu file eksplisit (kompatibel dengan pemanggil lama).
          const res2 = await injectHandoff(slug, String(body.file));
          sendJson(res, res2.ok ? 200 : 400, res2);
        } else {
          // Default: suntik ke semua target konvensi tool (AGENTS/CLAUDE/GEMINI).
          const results = await injectHandoffAll(slug);
          sendJson(res, results.some((r) => r.ok) ? 200 : 400, { ok: results.some((r) => r.ok), results });
        }
      } else if (url.pathname === "/api/handoff/remove" && req.method === "POST") {
        const body = await readBody(req);
        const proj = resolveProject(String(body.slug || ""));
        const results = removeInjectAll(proj ? proj.slug : String(body.slug || ""));
        sendJson(res, results.some((r) => r.ok) ? 200 : 400, { ok: results.some((r) => r.ok), results });
      } else if (url.pathname === "/api/backup" && req.method === "POST") {
        pruneArchivedBackups();
        const p = backupDb();
        sendJson(res, p ? 200 : 500, { ok: !!p, path: p });
      } else if (url.pathname === "/api/continuity" && req.method === "GET") {
        // B8: metrik limit-hopping — berapa kali limit terpicu, seberapa cepat
        // resume siap, dan "berapa penjelasan ulang terhemat".
        const { continuityStats } = await import("./store/db");
        const s = continuityStats();
        const { usageSummary } = await import("./retrieve/usage");
        sendJson(res, 200, {
          ...s,
          reExplanationsSaved: s.resumesReady30d,
          usage7d: usageSummary(7),
        });
      } else if (url.pathname === '/api/drafts/clean-noise' && req.method === 'POST') {
        // PR-N2: hapus draft yang cocok pola noise (status tool, badge shields.io,
        // debris markdown). Eksplisit dari UI — tidak pernah otomatis.
        const { isGenericMemory } = await import('./extract/extractor');
        const { listDraft, deleteMemory } = await import('./store/db');
        const drafts = listDraft();
        let removed = 0;
        withTx(() => {
          for (const m of drafts) {
            if (m.origin !== "user" && isGenericMemory(m.content)) {
              if (deleteMemory(m.id!)) removed++;
            }
          }
        });
        sendJson(res, 200, { ok: true, removed, scanned: drafts.length });
      } else if (url.pathname === "/api/consolidate" && req.method === "POST") {
        // PR-B: konsolidasi manual (dashboard/CLI) — jalankan sekali sekarang.
        const { consolidateMemories } = await import("./extract/consolidate");
        const r = await consolidateMemories();
        sendJson(res, 200, { ok: true, ...r });
      } else if (url.pathname === "/api/memories/purge" && req.method === "POST") {
        // PR-M: purge massal satu proyek — BUTUH confirm:true (destruktif).
        const body = await readBody(req);
        const proj = resolveProject(String(body.slug || ""));
        if (!proj) {
          sendJson(res, 404, { error: "project not found" });
          return;
        }
        if (body.confirm !== true) {
          const n = (getDb().prepare("SELECT COUNT(*) AS c FROM memories WHERE project_id = ? AND archived = 0").get(proj.id) as { c: number }).c;
          sendJson(res, 200, { ok: false, needsConfirm: true, project: proj.slug, memories: n });
          return;
        }
        const rows = getDb().prepare("SELECT id FROM memories WHERE project_id = ? AND archived = 0").all(proj.id) as Array<{ id: number }>;
        let removed = 0;
        withTx(() => {
          for (const r of rows) {
            if (deleteMemory(r.id)) removed++;
          }
        });
        emitEvent("memory", { kind: "purge" });
        sendJson(res, 200, { ok: true, removed, project: proj.slug });
      } else if (url.pathname === "/api/import/markdown" && req.method === "POST") {
        // PR-G: Obsidian dua arah — sisi import folder .md → memori.
        const body = await readBody(req);
        const folder = String(body.folder || "").trim();
        if (!folder) {
          sendJson(res, 400, { error: "folder wajib" });
          return;
        }
        try {
          const { importMarkdownNotes } = await import("./import/markdown");
          const r = await importMarkdownNotes(folder, String(body.project || "") || undefined);
          sendJson(res, 200, { ok: true, ...r });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String((e as Error).message || e) });
        }
      } else if (url.pathname === "/api/projects/brief" && req.method === "POST") {
        // A4: regenerate project brief on-demand (dipakai juga untuk test UI).
        const body = await readBody(req);
        const proj = resolveProject(String(body.slug || ""));
        if (!proj) {
          sendJson(res, 404, { error: "project not found" });
          return;
        }
        const { generateProjectBrief } = await import("./store/db");
        const brief = await generateProjectBrief(proj.id);
        sendJson(res, brief ? 200 : 404, { ok: !!brief, brief: brief?.content ?? null });
      } else if (url.pathname === "/api/integrations" && req.method === "GET") {
        sendJson(res, 200, { integrations: integrationStatus() });
      } else if (url.pathname === "/api/integrate" && req.method === "POST") {
        const body = await readBody(req);
        sendJson(res, 200, registerIntegration(String(body.tool || "")));
      } else if (url.pathname === "/api/git" && req.method === "GET") {
        const { projectRecord } = await import("./store/db");
        const proj = projectRecord(url.searchParams.get("slug") || "");
        const log = proj?.path ? await runGitLog(proj.path, 20) : [];
        sendJson(res, 200, { log });
      } else if (url.pathname === "/api/timeline" && req.method === "GET") {
        const db = (await import("./store/db")).getDb();
        const slug = url.searchParams.get("slug") || "";
        const limit = Number(url.searchParams.get("limit") || 40);
        const proj = (await import("./store/db")).projectRecord(slug);
        const rows = proj
          ? (db
              .prepare("SELECT role, content, ts, tool FROM transcripts WHERE project_id = ? ORDER BY ts DESC LIMIT ?")
              .all(proj.id, limit) as Array<{ role: string; content: string; ts: number; tool: string }>)
          : [];
        const mems = proj ? readMemoriesLite("WHERE project_id = " + proj.id + " AND archived = 0 AND status = 'active'").slice(0, 60) : [];
        sendJson(res, 200, {
          timeline: rows.map((r) => ({ ...r, text: r.content.slice(0, 500) })),
          memories: mems.map((m) => ({ id: m.id, kind: m.kind, content: m.content, importance: m.importance, createdAt: m.createdAt, sourceTool: m.sourceTool })),
        });
      } else if (url.pathname === "/api/tags" && req.method === "GET") {
        sendJson(res, 200, { tags: allTags(Number(url.searchParams.get("min") || 1)) });
      } else if (url.pathname === "/api/tags/rebuild" && req.method === "POST") {
        const { rebuildTopics } = await import("./extract/topics");
        const r = rebuildTopics();
        sendJson(res, 200, r);
      } else if (url.pathname === "/api/memories/tag" && req.method === "GET") {
        const tag = url.searchParams.get("tag") || "";
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50)));
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0) || 0);
        const ids = memoriesByTag(tag);
        const total = ids.length;
        const byId = new Map(readMemoriesLite("WHERE archived = 0 AND status = 'active'").map((m) => [m.id as number, m]));
        const mems = ids
          .slice(offset, offset + limit)
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map((m) => enrichMemory({ ...m, type: undefined, projectSlug: projectSlugById(m!.projectId) }));
        sendJson(res, 200, {
          memories: mems.map((m: any) => ({ id: m.id, kind: m.kind, content: m.content, importance: m.importance, createdAt: m.createdAt, sourceTool: m.sourceTool, status: m.status, projectSlug: m.projectSlug, entities: m.entities, tags: m.tags })),
          total,
          offset,
          limit,
          hasMore: offset + mems.length < total,
        });
      } else if (url.pathname === "/api/journal" && req.method === "GET") {
        const { learningJournal } = await import("./summary/journal");
        const { resolveProject } = await import("./store/db");
        const slug = url.searchParams.get("project") || "";
        const proj = slug ? resolveProject(slug) : null;
        if (slug && !proj) {
          sendJson(res, 404, { error: "unknown project" });
          return;
        }
        sendJson(res, 200, learningJournal({ days: Number(url.searchParams.get("days") || 7), project: proj ? proj.id : null }));
      } else if (url.pathname === "/api/digest" && req.method === "GET") {
        const { latestDigestText } = await import("./summary/weekly");
        sendJson(res, 200, { text: latestDigestText() });
      } else if (url.pathname === "/api/digest/generate" && req.method === "POST") {
        const { generateWeeklyDigest } = await import("./summary/weekly");
        sendJson(res, 200, generateWeeklyDigest());
      } else if (url.pathname === "/api/import/chats" && req.method === "POST") {
        // Raw upload of a ChatGPT / Claude export (.zip or conversations.json),
        // streamed to a temp file: exports are often far above MAX_BODY_BYTES.
        const os = await import("node:os");
        const p = await import("node:path");
        const tmp = p.join(fs.mkdtempSync(p.join(os.tmpdir(), "memoria-chat-")), "export.bin");
        const LIMIT = 1024 * 1024 * 1024;
        try {
          await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(tmp, { mode: 0o600 });
            let size = 0;
            req.on("data", (c: Buffer) => {
              size += c.length;
              if (size > LIMIT) {
                req.destroy();
                out.destroy();
                reject(new Error("export larger than 1 GB"));
              }
            });
            req.pipe(out);
            out.on("finish", () => resolve());
            out.on("error", reject);
            req.on("error", reject);
          });
          const { importChatExport } = await import("./import/chats");
          const r = importChatExport(tmp);
          emitEvent("scan", { tools: [r.source], newTranscripts: r.messages });
          void extractQueue(true).catch(() => {});
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        } finally {
          fs.rmSync(p.dirname(tmp), { recursive: true, force: true });
        }
      } else if (url.pathname === "/api/obsidian/sync" && req.method === "POST") {
        const body = await readBody(req);
        const dir = String(body.dir || getSetting("obsidianVault", "")).trim();
        if (!dir) {
          sendJson(res, 400, { error: "dir is required" });
          return;
        }
        setSetting("obsidianVault", dir);
        const { syncObsidianVault } = await import("./export/obsidian");
        const r = syncObsidianVault(dir);
        if (r.updatedFromNotes || r.createdFromNotes || r.archivedFromNotes) emitEvent("memory", { obsidian: true });
        sendJson(res, 200, r);
      } else if (url.pathname === "/api/export/obsidian" && req.method === "POST") {
        const body = await readBody(req);
        const cfg = getConfig();
        const target = String(body.dir || "") || require("node:path").join(cfg.dataDir, "obsidian-export");
        const { exportObsidianVault } = await import("./export/obsidian");
        sendJson(res, 200, exportObsidianVault(target));
      } else if (url.pathname === "/api/export" && req.method === "GET") {
        const fmt = url.searchParams.get("format") || "md";
        const slug = url.searchParams.get("slug") || "";
        const proj = (await import("./store/db")).projectRecord(slug);
        const mems = proj ? readMemoriesLite("WHERE project_id = " + proj.id + " AND archived = 0") : readMemoriesLite("WHERE archived = 0");
        if (fmt === "json") {
          sendJson(res, 200, { memories: mems.map((m) => ({ ...m, embedding: undefined, project: projectSlugById(m.projectId) })) });
        } else {
          const text = mems
            .map((m) => `[${m.kind}] (${projectSlugById(m.projectId) ?? "global"} · ${(m.importance * 100).toFixed(0)})\n${m.content}`)
            .join("\n\n");
          sendJson(res, 200, { text });
        }
      } else if (url.pathname === "/api/import" && req.method === "POST") {
        const body = await readBody(req);
        const { insertTranscript } = await import("./store/db");
        const text = String(body.text || "").trim();
        const rawProject = String(body.project || "_import").trim();
        const projectId = ensureProject(projectSlugFromCwd(rawProject), looksLikePath(rawProject) ? rawProject : undefined);
        const tool = String(body.tool || "import");
        let ok = false;
        if (text) {
          ok = insertTranscript({
            tool,
            sessionId: `import-${Date.now()}`,
            projectId,
            role: "user",
            content: text,
            ts: Date.now(),
            seq: 0,
          });
        }
        sendJson(res, ok ? 200 : 400, { ok });
      } else if (url.pathname === "/api/graph" && req.method === "GET") {
        const project = url.searchParams.get("project") || undefined;
        const limit = Number(url.searchParams.get("limit") || 250);
        sendJson(res, 200, graphSnapshot(project, limit));
      } else if (url.pathname === "/api/graph/rebuild" && req.method === "POST") {
        const n = rebuildAllLinks();
        sendJson(res, 200, { ok: true, links: n });
      } else if (url.pathname === "/api/related" && req.method === "GET") {
        const id = Number(url.searchParams.get("id") || 0);
        const rel = relatedMemories(id, 8);
        sendJson(res, 200, {
          related: rel.map((r) => ({
            ...r.memory,
            embedding: undefined,
            projectSlug: projectSlugById(r.memory.projectId),
            linkKind: r.linkKind,
            linkWeight: r.weight,
          })),
        });
      } else if (url.pathname === "/api/sync/status" && req.method === "GET") {
        const { syncStatus } = await import("./sync/keys");
        const { getFolderStatus } = await import("./sync/folder");
        let status: any;
        try {
          status = syncStatus({});
        } catch (e) {
          status = { configured: false, error: e instanceof Error ? e.message : String(e) };
        }
        let folder: any = null;
        try {
          folder = getFolderStatus();
        } catch {
          folder = null;
        }
        sendJson(res, 200, { status, folder });
      } else if (url.pathname === "/api/sync/conflicts" && req.method === "GET") {
        const { listRecentConflicts } = await import("./sync/folder");
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 50) || 50));
        sendJson(res, 200, { conflicts: listRecentConflicts(limit) });
      } else if (url.pathname === "/api/sync/folder" && req.method === "POST") {
        const body = await readBody(req);
        const { setSharedFolder, scanAndApplyFolder, startFolderWatcher } = await import("./sync/folder");
        const target = body.clear ? "" : String(body.path || "").trim();
        try {
          const st = setSharedFolder(target || null);
          if (st.path) {
            await scanAndApplyFolder({});
            startFolderWatcher();
          }
          sendJson(res, 200, { ok: true, folder: st });
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String((e as Error).message || e) });
        }
      } else if (url.pathname === "/api/events" && req.method === "GET") {
        // SSE: sinyal live (memory/scan/tasks) — client yang memutuskan refresh-nya.
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write("event: hello\ndata: {}\n\n");
        const listener = (type: string, data?: unknown) => {
          // M14 (audit): cek writable — client yang mati mendadak (laptop
          // sleep) tidak boleh menumpuk buffer / error tak tertangani.
          if (res.writableEnded || res.destroyed) return;
          res.write(`event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
        };
        addListener(listener);
        const hb = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(hb);
            return;
          }
          res.write(": hb\n\n");
        }, 25000);
        res.on("error", () => {
          clearInterval(hb);
          removeListener(listener);
        });
        req.on("close", () => {
          clearInterval(hb);
          removeListener(listener);
        });
      } else {
        sendJson(res, 404, { error: "not found" });
      }
    } catch (e) {
      console.error("[memoria] API error:", url.pathname, e);
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  // Bind eksplisit ke loopback — tanpa ini Node bind ke semua interface (LAN ikut kebuka).
  return new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      console.log(`[memoria] HTTP API on http://127.0.0.1:${port} (this machine only)`);
      try {
        getApiToken(); // create the token file on first start
        const { upgradePlaintextSecrets } = require("./store/secure") as typeof import("./store/secure");
        const upgraded = upgradePlaintextSecrets();
        if (upgraded.length) console.log(`[memoria] Encrypted secrets stored in plaintext by older versions: ${upgraded.join(", ")}`);
        const { refreshHttpIntegrations } = require("./integrate") as typeof import("./integrate");
        const fixed = refreshHttpIntegrations();
        if (fixed.length) console.log(`[memoria] Added API token header to MCP config: ${fixed.join(", ")}`);
      } catch (err) {
        console.warn("[memoria] api token:", err instanceof Error ? err.message : err);
      }
      resolve();
    });
  });
}