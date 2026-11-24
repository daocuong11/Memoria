import { getDb, getPendingExtraction, markExtracted, projectSlugById, getBoolSetting } from "../store/db";
import { getExtractProvider, getEmbedProvider, embedManyVia } from "./provider";
import { addMemoryWithDedupe } from "./dedupe";
import { triageCandidate } from "./heuristic";
import { matchesUserNoise, userNoisePatterns } from "./triage";

let running = false;
let lastAttempt = 0;

/* PR-37 H5 (audit): dua kelas pola supaya filter tidak membunuh memori nyata.
 * NOISE_ANY — cocok di string mana pun (status tool, badge shields.io):
 *   kehadirannya sendiri sudah menandakan noise.
 * NOISE_STRUCT — pola STRUKTURAL ber-anchor (fence, debris bullet, kalimat
 *   meta pembuka): hanya noise bila MENDOMINASI konten (>= 50% baris) atau
 *   seluruh string cocok. Dulu satu fence/bullet di tengah memori multi-baris
 *   yang valid menghapus semuanya. */
const NOISE_ANY = [
  /has been updated successfully/i,
  /modified \d+ files? (you|you've|you have) previously read/i,
  /\[!\[[^\]]*\]\(https?:\/\/img\.shields\.io/i,
  /img\.shields\.io\/badge\//i,
  /^\[!\w+\]\(/,
  /help the user/i,
  /assist the user/i,
  /user['’]s request/i,
  /user['’]s needs/i,
  /determine what to (create|fix)/i,
  /gather information about the project/i,
  /proceed with the (task|request)/i,
  /identify the (task|requirement)/i,
  /understand the user/i,
];
const NOISE_STRUCT = [
  /^\s*```/,
  /^\s*(--|\*)\s*\*\*[^*]+\*\*/,
  /^understand what/i,
  /^what to build/i,
  /^the next step is to/i,
];

export function isGenericMemory(content: string): boolean {
  const c = content.toLowerCase();
  if (c.length < 15) return true;
  // Per-baris + keseluruhan: noise badge/status biasanya SATU BARIS di tengah
  // konten multi-baris, bukan seluruh string.
  const lines = c.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of [c, ...lines]) {
    for (const p of NOISE_ANY) {
      if (p.test(line)) return true;
    }
  }
  const structHits = lines.filter((l) => NOISE_STRUCT.some((p) => p.test(l))).length;
  if (lines.length && structHits / lines.length >= 0.5) return true;
  if (NOISE_STRUCT.some((p) => p.test(c))) return true;
  return false;
}

/** Turn reports are served for three days, then the lifecycle step retires them. */
const REPORT_TTL_MS = 3 * 86_400_000;

export async function extractQueue(force = false, opts: { order?: "asc" | "desc" } = {}): Promise<number> {
  if (running) return 0;
  if (!force && Date.now() - lastAttempt < 30_000) return 0;
  lastAttempt = Date.now();
  running = true;
  let extracted = 0;
  try {
    // Tiered intelligence: pilihan mesin dibaca tiap siklus (ubah di Pengaturan
    // langsung aktif). Tanpa model apapun pun, heuristik tetap menghasilkan memori.
    const extractProv = await getExtractProvider();
    const embedProv = await getEmbedProvider();
    // order "desc" = sesi TERBARU diproses duluan — dipakai hot-path resume agar
    // konteks untuk pindah tool tersedia secepatnya, sisanya menyusul di background.
    // Structured events first (todos, answered questions): explicit data, no
    // sentence heuristics, so they do not wait for the transcript queue.
    try {
      const { materializeEvents } = await import("./events");
      const ev = await materializeEvents((text) => embedProv.embed(text), { embedModel: embedProv.embedModel });
      extracted += ev.created;
    } catch {
      /* non-blocking: transcript extraction still runs */
    }
    const pending = getPendingExtraction(160, opts.order ?? "asc");
    if (!pending.length) return extracted;
    // Heuristik: sinyal kuat (task/decision/error-fix/fakta ber-entitas) dipromosikan
    // ke ACTIVE agar resume/recall/link lintas-AI langsung jalan saat limit-hopping;
    // sisanya tetap draft (review queue). Transparan via origin "heuristic".
    const heuristic = extractProv.id === "heuristic";
    const userPatterns = heuristic ? userNoisePatterns() : [];
    const defaultStatus = heuristic ? "draft" : getBoolSetting("reviewMode", false) ? "draft" : "active";
    const origin = heuristic ? "heuristic" : "llm";

    const bySession = new Map<string, typeof pending>();
    for (const t of pending) {
      const key = `${t.projectId}:${t.sessionId}`;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key)!.push(t);
    }

    for (const rows of bySession.values()) {
      const sorter = rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
      const projectId = rows[0].projectId;
      const tool = rows[0].tool;
      let autoPromoted = 0;
      // Dulu batas keras 8/sesi membuat kandidat bagus di sesi panjang terparkir
      // sebagai draft. Kini kuota mengikuti panjang sesi (noise sudah dibuang
      // oleh triage), dengan batas atas agar satu sesi tidak membanjiri.
      const MAX_AUTO_PROMOTE = Math.min(40, 10 + Math.ceil(sorter.length / 6));

      // Tier 0 reads a session turn by turn, so it gets the whole pending part
      // at once; an LLM gets windows that fit its context.
      const windows: typeof pending[] = [];
      const CHUNK = heuristic ? sorter.length || 1 : 24;
      for (let i = 0; i < sorter.length; i += CHUNK) {
        windows.push(sorter.slice(i, i + CHUNK));
      }

      for (const winRows of windows) {
        // Heuristik butuh peran "tool" untuk melewati output mesin; LLM
        // menerima format lama (user/assistant) agar perilakunya tidak berubah.
        const conversation = winRows.map((r) => ({
          role: r.role === "user" ? "user" : heuristic && (r.role === "tool" || r.role === "system") ? r.role : "assistant",
          content: r.content,
        }));
        const memories = await extractProv.extract(projectSlugById(projectId) || "unknown", conversation);
        const ids = winRows.map((r) => r.id as number).filter((x) => x != null);
        if (!memories) break; // provider bermasalah → coba siklus berikutnya
        const kept = memories.filter((mem) => !isGenericMemory(mem.content) && mem.importance >= 0.3);
        // Batch embedding: satu panggilan untuk seluruh window (F1C).
        const embs = await embedManyVia(embedProv, kept.map((m) => m.content));
        kept.forEach((mem, i) => {
          let status = defaultStatus;
          let importance = mem.importance;
          const report = heuristic && (mem as any).memoryClass === "working";
          if (report) {
            // Turn report: short-lived resume context, not a lasting fact.
            addMemoryWithDedupe({
              projectId: projectId || null, kind: "context", content: mem.content, importance: mem.importance,
              createdAt: winRows[winRows.length - 1]?.ts || Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: tool,
              embedding: embs[i], status: "active", origin, embedModel: embs[i] ? embedProv.embedModel : "",
              sourceSession: rows[0].sessionId || "", memoryClass: "working",
              expiresAt: (winRows[winRows.length - 1]?.ts || Date.now()) + REPORT_TTL_MS,
            });
            extracted++;
            return;
          }
          if (heuristic) {
            // "Always archive drafts like this" patterns from the inbox.
            if (userPatterns.length && matchesUserNoise(mem.content, userPatterns)) return;
            const t = triageCandidate(mem as any);
            // archive = noise / skor rendah: tidak disimpan sama sekali
            // (transkrip asal tetap ada, bisa diekstrak ulang).
            if (t.decision === "archive") return;
            if (t.decision === "active" && autoPromoted < MAX_AUTO_PROMOTE) {
              status = "active";
              autoPromoted++;
              // sinyal kuat sedikit dinaikkan agar mudah muncul di resume/context
              importance = Math.max(importance, t.signals.some((s) => ["path", "cmd", "err"].includes(s)) ? 0.58 : 0.52);
            } else {
              status = "draft";
            }
          }
          addMemoryWithDedupe({
            projectId: projectId || null,
            kind: mem.kind,
            content: mem.content,
            importance,
            createdAt: winRows[0]?.ts || Date.now(),
            lastAccessed: 0,
            accessCount: 0,
            sourceTool: tool,
            embedding: embs[i],
            status,
            origin,
            embedModel: embs[i] ? embedProv.embedModel : "",
            // Provenance: sesi sumber → tiap memori bisa ditelusuri ke
            // percakapan asalnya (A2/Hindsight-style traceability).
            sourceSession: rows[0].sessionId || "",
          });
          extracted++;
        });
        for (const id of ids) markExtracted(id);
      }
      if (projectId != null) {
        const { runTaskLifecycle } = await import("./tasklife");
        runTaskLifecycle(projectId);
      }
    }
  } catch {
    // retry next cycle
  } finally {
    running = false;
    try {
      (await import("./expire")).retireExpired();
    } catch {
      /* lifecycle is best effort */
    }
  }
  return extracted;
}

export function runHousekeeping(): void {
  const d = getDb();
  d.prepare(
    "UPDATE transcripts SET extracted = 1 WHERE content IS NULL OR TRIM(content) = ''"
  ).run();
}