/* ---------- HeuristicProvider (Tier 0 — tanpa model, tanpa network) ----------
 * Tujuan: user TANPA Ollama/API key tetap mendapatkan memori sejak menit pertama
 * dan, saat limit-hopping, tool berikutnya langsung punya konteks.
 *  - extract: deteksi berbasis aturan (kalimat + list/checkbox + pola ID/EN)
 *    memanfaatkan gaya percakapan dev/AI: keputusan, task, error-fix, preferensi,
 *    fakta ber-entitas (path/command/url/versi/teknologi).
 *  - embed: hashing TF-IDF 256 dim (FNV-1a), pure JS — cukup untuk dedupe +
 *    kemiripan/graph; upgrade ke model embedding tetap didukung (backfill).
 * Kualitas tiap memori dinilai (confidence/signal). Sinyal kuat dapat
 * diaktifkan langsung (active, origin "heuristic") agar resume/recall/link
 * lintas-AI bekerja instan; sisanya masuk draft untuk tinjau.
 * ----------------------------------------------------------------------------- */

import { noiseReason, letterRatio, wordCount } from "./noise";

export const HASH_MODEL = "hash-256-v1";

const HASH_DIM = 256;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const TOKEN_RE = /[\s,.;:!?"'()[\]{}<>\\/|@#$%^&*+=~`-]+/;

/** Embedding murah tanpa model: hashing trick + normalisasi L2. */
export function hashEmbed(text: string): number[] {
  const vec = new Array<number>(HASH_DIM).fill(0);
  const tokens = text.toLowerCase().split(TOKEN_RE).filter((t) => t.length > 1);
  if (!tokens.length) return vec;
  const counts = new Map<number, number>();
  // unigram + bigram kata + trigram karakter (membantu path/identifier/typo)
  const grams: string[] = [...tokens];
  for (let i = 0; i < tokens.length - 1; i++) grams.push(tokens[i] + "_" + tokens[i + 1]);
  for (const t of tokens) {
    if (t.length >= 4) {
      for (let i = 0; i <= t.length - 3; i++) grams.push("c:" + t.slice(i, i + 3));
    }
  }
  for (const g of grams) {
    const h = fnv1a(g) % HASH_DIM;
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  for (const [h, c] of counts) vec[h] = 1 + Math.log(c); // sublinear TF
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < HASH_DIM; i++) vec[i] /= norm;
  return vec;
}

/* ---------------- Ekstraksi berbasis aturan ---------------- */

export type HeuristicKind = "fact" | "decision" | "task_done" | "task_pending" | "error_fixed" | "preference" | "context";

export interface HeuristicMemory {
  kind: HeuristicKind;
  content: string;
  importance: number;
  /** 0..1 — dipakai untuk auto-activate fast-path (kontinuitas limit-hopping). */
  confidence?: number;
  signal?: string[];
  /** 'working' = short-lived (a turn report); '' or 'durable' otherwise. */
  memoryClass?: "working" | "durable";
}

interface Rule {
  kind: Exclude<HeuristicKind, "context">;
  re: RegExp;
  base: number;
  conf: number;
  sig: string;
}

// Urutan = prioritas klasifikasi (paling spesifik dulu).
const RULES: Rule[] = [
  { kind: "error_fixed", base: 0.6, conf: 0.85, sig: "error_fix", re: /\b(error|bug|gagal|failed|exception|traceback|crash|stack ?trace|panic|uncaught)\b[\s\S]{0,120}\b(fix|fixed|perbaik|solusi|ternyata|penyebab|solved|resolved|workaround|patch|handled)\b|\b(fix|fixed|perbaik|solusi|ternyata|penyebab|workaround|resolved|solved)\b[\s\S]{0,120}\b(error|bug|gagal|failed|exception|traceback|crash|panic)\b/i },
  { kind: "task_done", base: 0.5, conf: 0.8, sig: "done", re: /\b(sudah selesai|sudah dibuat|sudah diperbaiki|sudah ditambahkan|sudah diimplementasi|sudah beres|selesai dikerjakan|berhasil dibuat|done|completed|implemented|finished|shipped|merged|resolved|fixed now)\b/i },
  { kind: "task_pending", base: 0.62, conf: 0.8, sig: "todo", re: /\b(todo|to-do|next step|next steps|follow[- ]?up|remaining|still need|not yet|belum selesai|belum dibuat|akan dibuat|akan ditambahkan|tinggal|lanjut(kan)?|perlu dibuat|perlu diperbaiki|perlu ditambah|harus di|nanti|blocked|wip|in progress|plan to|need to|should)\b/i },
  { kind: "decision", base: 0.62, conf: 0.82, sig: "decision", re: /\b(keputusan|disepakati|diputuskan|kita pakai|kita pilih|kami pakai|pakai saja|memakai|menggunakan|pilih|daripada|decided|we('ll| will)? use|going with|chose|chosen|instead of|settle(d)? (on|for)|opt(ed)? for|use .+ (for|as))\b/i },
  { kind: "preference", base: 0.5, conf: 0.7, sig: "preference", re: /\b(prefer|lebih suka|jangan |usahakan |selalu |hindari |gaya kode|code style|favor|always |never |avoid |please (don't|do not))\b/i },
  { kind: "fact", base: 0.48, conf: 0.65, sig: "entity", re: /(\bv?\d+\.\d+(\.\d+)?\b)|(https?:\/\/)|([\w.@+-]+\/[\w.@+\/-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|md|json|ya?ml|toml|sql|sh|css|scss|html|vue|svelte|kt|swift|c|cpp|h|hpp))|(\b(port|endpoint|default|timeout|limit|schema|table|branch|version|versi)\b\s*[:=]?\s*\S+)/i },
];

const SENTENCE_RE = /\n{2,}|(?<=[.!?])\s+/;
const GENERIC_RE = /\b(identifika|mengidentifikasi|memahami|memperhatikan|membantu (pengguna|user)|kebutuhan (pengguna|user)|menentukan apa|langkah berikutnya adalah|melanjutkan tugas|how can i help|let me know|feel free)\b/i;
const PATH_LIKE = /(^|[\s`("'`])([A-Za-z]:\\|~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,8}\b|(^|[\s`])[\w-]+\.(ts|tsx|js|jsx|py|go|rs|java|md|json|ya?ml|toml|sql|css|html)\b/;
const CMD_LIKE = /\b(npm|pnpm|yarn|bun|node|npx|git|gh|python3?|pip3?|cargo|go |make|docker|kubectl|curl|ssh|tsc|vite|next|uv)\b[^\n]{0,80}/i;
const ERR_LIKE = /\b(Error|Exception|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES|ECONN|Traceback|panic|failed|Cannot |not found)\b/;

function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_RE)
    .map((s) => s.trim())
    .filter((s) => s.length >= 18 && s.length <= 320);
}

function normalizeContent(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[-*>\d.)\[\]xX ]+/, "").trim();
}

function classifySentence(sentence: string): { kind: Exclude<HeuristicKind, "context">; importance: number; confidence: number; signals: string[] } | null {
  for (const r of RULES) {
    if (r.re.test(sentence)) {
      let confidence = r.conf;
      const signals = [r.sig];
      if (PATH_LIKE.test(sentence)) { confidence += 0.05; signals.push("path"); }
      if (CMD_LIKE.test(sentence)) { confidence += 0.04; signals.push("cmd"); }
      if (ERR_LIKE.test(sentence) && r.kind === "error_fixed") { confidence += 0.04; signals.push("err"); }
      if (/\bhttps?:\/\//.test(sentence) || /\bv?\d+\.\d+/.test(sentence)) { confidence += 0.03; signals.push("ref"); }
      return { kind: r.kind, importance: Math.min(0.85, r.base), confidence: Math.min(0.98, confidence), signals };
    }
  }
  return null;
}

function extractListItems(text: string): Array<{ content: string; kind: HeuristicKind; confidence: number; signals: string[]; importance: number }> {
  const out: Array<{ content: string; kind: HeuristicKind; confidence: number; signals: string[]; importance: number }> = [];
  const lines = text.split("\n");
  for (const raw of lines) {
    const m = raw.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[( |x|X)\]\s*)?(.*)$/);
    if (!m) continue;
    const checked = m[1];
    const body = normalizeContent(m[2] || "");
    if (body.length < 12 || body.length > 280) continue;
    if (GENERIC_RE.test(body)) continue;
    if (checked === "x" || checked === "X") {
      out.push({ content: body, kind: "task_done", confidence: 0.86, signals: ["checkbox_done"], importance: 0.55 });
      continue;
    }
    if (checked === " ") {
      out.push({ content: body, kind: "task_pending", confidence: 0.86, signals: ["checkbox_todo"], importance: 0.62 });
      continue;
    }
    const cls = classifySentence(body);
    if (cls && (cls.kind === "task_pending" || cls.kind === "task_done" || cls.kind === "decision" || cls.kind === "error_fixed")) {
      out.push({ content: body, kind: cls.kind, confidence: Math.max(cls.confidence, 0.78), signals: [...cls.signals, "list"], importance: cls.importance });
    } else if (/^(todo|next|plan|fix|add|implement|update|create|remove|refactor|investigate|check|verify|test)\b/i.test(body) || /\b(tinggal|lanjut|perlu|harus|akan)\b/i.test(body)) {
      out.push({ content: body, kind: "task_pending", confidence: 0.78, signals: ["list", "imperative"], importance: 0.6 });
    }
  }
  return out;
}

function extractCodeSignals(text: string): HeuristicMemory[] {
  const out: HeuristicMemory[] = [];
  // fenced code: capture file-ish hints in info string and short error/command lines inside
  const fences = text.match(/```[\s\S]*?```/g) || [];
  for (const f of fences.slice(0, 3)) {
    const inner = f.replace(/```[^\n]*\n?|```/g, "");
    const lines = inner.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.length < 12 || line.length > 220) continue;
      if (ERR_LIKE.test(line) && /\b(fix|fixed|solved|resolved|use|set|change|add|remove)\b/i.test(inner)) {
        out.push({ kind: "error_fixed", content: line, importance: 0.6, confidence: 0.72, signal: ["code", "err"] });
      } else if (CMD_LIKE.test(line)) {
        out.push({ kind: "fact", content: `Command: ${line.slice(0, 180)}`, importance: 0.5, confidence: 0.72, signal: ["code", "cmd"] });
      }
    }
  }
  return out.slice(0, 3);
}

function dedupeKey(content: string): string {
  return content.toLowerCase().replace(/[`*_#>\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function scoreForRank(m: HeuristicMemory): number {
  return (m.confidence ?? 0.5) * 2 + m.importance + ((m.signal || []).length > 0 ? 0.1 : 0);
}

/* ---------- Triage Tier 0: active / draft / archive ----------
 * Dulu: semua hasil heuristik default ke draft, hanya ≤8 per sesi yang lolos
 * ambang sempit → ribuan draft menumpuk menunggu approve manual. Kini setiap
 * kandidat diberi skor yang bisa diaudit (alasan tercatat) dan langsung
 * diputuskan. Draft hanya untuk yang benar-benar ragu, dan punya umur
 * (lihat extract/triage.ts). Ambang bisa disetel via settings
 * heuristicActiveAt / heuristicArchiveAt. */

export type TriageDecision = "active" | "draft" | "archive";

export interface TriageResult {
  decision: TriageDecision;
  score: number;
  confidence: number;
  signals: string[];
  /** Alasan utama keputusan (noise:<rule>, low-score, …) — untuk UI & log. */
  reason: string;
}

const STRONG_SIGNALS = new Set(["decision", "error_fix", "checkbox_todo", "checkbox_done", "todo", "done"]);
const KIND_BASE: Record<string, number> = {
  decision: 0.5,
  error_fixed: 0.52,
  task_pending: 0.44,
  task_done: 0.4,
  preference: 0.48,
  fact: 0.3,
  context: 0.3,
};
const EXPLICIT_DECISION = /\b(keputusan|disepakati|diputuskan|sepakat|kita pakai|kita pilih|kami pakai|kami pilih|pakai saja|pakai aja|daripada|alih-alih|ketimbang|decided|decision|we('ll| will)? (use|go with)|going with|chose|chosen|instead of|rather than|settled? (on|for)|opt(ed)? for|switch(ed)? to|migrat(e|ed) to|ganti ke|pindah ke)\b/i;
const EXPLICIT_TASK = /\b(todo|to-do|next steps?|follow[- ]?up|remaining|still need|not yet|belum (selesai|dibuat|ada|jalan|di)|perlu (dibuat|diperbaiki|ditambah|dicek|di)|harus (di|dibuat)|need to|needs to|must|blocked|blocker|wip|plan to|akan (dibuat|ditambahkan|dikerjakan)|lanjutkan|kerjakan|implement|tambahkan|perbaiki|fix)\b/i;
const DEICTIC_START = /^(ini|itu|tadi|yang tadi|this|that|it|these|those|they|he|she|dia|mereka)\b/i;

export const DEFAULT_ACTIVE_AT = 0.6;
export const DEFAULT_ARCHIVE_AT = 0.36;

function thresholds(): { activeAt: number; archiveAt: number } {
  try {
    // lazy require: modul ini juga dipakai tanpa DB (unit test murni)
    const db = require("../store/db") as typeof import("../store/db");
    const a = Number(db.getSetting("heuristicActiveAt", ""));
    const b = Number(db.getSetting("heuristicArchiveAt", ""));
    return {
      activeAt: Number.isFinite(a) && a > 0 ? a : DEFAULT_ACTIVE_AT,
      archiveAt: Number.isFinite(b) && b > 0 ? b : DEFAULT_ARCHIVE_AT,
    };
  } catch {
    return { activeAt: DEFAULT_ACTIVE_AT, archiveAt: DEFAULT_ARCHIVE_AT };
  }
}

/** Nilai satu kandidat. Murni (tanpa I/O kecuali membaca ambang). */
export function triageCandidate(m: { kind: string; content: string; importance: number; confidence?: number; signal?: string[] }): TriageResult {
  const content = (m.content || "").replace(/\s+/g, " ").trim();
  const signals = [...(m.signal || [])];
  let confidence = Math.min(0.99, m.confidence ?? 0.6);
  const noise = noiseReason(content);
  if (noise) return { decision: "archive", score: 0, confidence, signals, reason: `noise:${noise}` };
  if (GENERIC_RE.test(content)) return { decision: "archive", score: 0, confidence, signals, reason: "noise:generic" };

  if (PATH_LIKE.test(content) && !signals.includes("path")) signals.push("path");
  if (CMD_LIKE.test(content) && !signals.includes("cmd")) signals.push("cmd");
  if (ERR_LIKE.test(content) && !signals.includes("err")) signals.push("err");

  const words = wordCount(content);
  const sentence = words >= 5 && letterRatio(content) >= 0.65;
  let score = KIND_BASE[m.kind] ?? 0.3;
  score += (confidence - 0.6) * 0.5;
  // Pola keputusan luas ("memakai", "menggunakan", "pilih") cocok dengan
  // kalimat deskriptif biasa. Bonus sinyal kuat hanya untuk keputusan eksplisit.
  const weakDecision = m.kind === "decision" && !EXPLICIT_DECISION.test(content);
  // Sama untuk task: "nanti"/"tinggal"/"lanjut" sering muncul di kalimat naratif.
  const weakTask = m.kind === "task_pending" && !signals.includes("checkbox_todo") && !EXPLICIT_TASK.test(content);
  if (weakDecision || weakTask) score -= 0.08;
  if (signals.some((s) => STRONG_SIGNALS.has(s) && !(weakDecision && s === "decision") && !(weakTask && s === "todo"))) score += 0.12;
  if (signals.includes("user")) score += 0.08; // ucapan user asli (bukan output tool)
  // Entitas (path/cmd/error) menambah nilai HANYA bila ada kalimat penjelas —
  // dulu URL/path lepas dihitung "spesifik" dan ikut dipromosikan.
  if (sentence && signals.some((s) => s === "path" || s === "cmd" || s === "err")) score += 0.06;
  // Fakta = kalimat lengkap + entitas konkret (port/versi/id/endpoint).
  if (m.kind === "fact" && sentence && words >= 8 && signals.includes("entity")) score += 0.08;
  if (/\b(karena|supaya|agar|biar|because|so that|since|instead of|daripada|alih-alih)\b/i.test(content)) score += 0.06;
  // Larangan/aturan eksplisit = preferensi/guardrail yang layak diingat lintas sesi.
  if (m.kind === "preference" && sentence && /\b(jangan|harus|wajib|selalu|hindari|never|always|must|do not|don't|avoid)\b/i.test(content)) score += 0.08;
  if (!sentence) score -= 0.22;
  if (/\?\s*$/.test(content)) score -= 0.2; // pertanyaan bukan fakta/keputusan/task
  if (DEICTIC_START.test(content) && words < 9) score -= 0.12; // butuh konteks yang hilang
  if (content.length > 300) score -= 0.08;
  score = Math.max(0, Math.min(1, score));

  const { activeAt, archiveAt } = thresholds();
  const decision: TriageDecision = score >= activeAt ? "active" : score < archiveAt ? "archive" : "draft";
  const reason = decision === "active" ? "strong" : decision === "archive" ? "low-score" : "uncertain";
  return { decision, score: Number(score.toFixed(3)), confidence, signals, reason };
}

/** Kompatibilitas API lama: activate = keputusan triage "active". */
export function assessHeuristicSignal(m: { kind: HeuristicKind; content: string; importance: number; confidence?: number; signal?: string[] }): { activate: boolean; confidence: number; signals: string[] } {
  const t = triageCandidate(m);
  return { activate: t.decision === "active", confidence: t.confidence, signals: t.signals };
}

/** Pulihkan sinyal untuk memori tersimpan (sinyal asli tidak disimpan di DB):
 * klasifikasi ulang kalimatnya dengan aturan yang sama seperti saat ekstraksi. */
export function rescoreStored(m: { kind: string; content: string; importance: number }): TriageResult {
  const content = m.content || "";
  const cb = /^\s*(?:[-*]|\d+[.)])?\s*\[( |x|X)\]/.exec(content);
  const cls = classifySentence(content);
  const signals = cb ? [cb[1] === " " ? "checkbox_todo" : "checkbox_done"] : cls ? cls.signals : [];
  const confidence = cls ? cls.confidence : 0.6;
  return triageCandidate({ kind: m.kind, content, importance: m.importance, confidence, signal: signals });
}

/* ---------------- Turn-aware extraction (quality phase Q3) ----------------
 * A turn is one user message plus everything the agent does until the next
 * user message. Measured on the owner's labels, 56% of real memories sit in
 * the agent's LAST message of a turn (its report), 13% in mid-turn messages
 * and those mid-turn messages are mostly narration ("Sekarang saya cek …").
 * So:
 * - mid-turn agent messages are skipped;
 * - the final agent message gives one `working` turn report plus at most
 *   MAX_PER_TURN durable candidates (strongest first);
 * - user messages give candidates too (preferences, decisions);
 * - a session-continuation summary (role system) is read like a report;
 * - tool output is never a source. */

const MAX_PER_TURN = Number(process.env.Q3_MAX || 3);
const REPORT_MAX = Number(process.env.Q3_REPORT || 600);
const CONTINUATION = /^This session is being continued from a previous conversation/;

/** The agent's final message, condensed: code blocks and tables dropped,
 * markdown markers removed, cut at a sentence end near REPORT_MAX. */
export function turnReport(text: string): string {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*[-=]{3,}\s*$/.test(l))
    .map((l) => l.replace(/^\s*#{1,6}\s+/, "").replace(/\*\*|__/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > REPORT_MAX) {
    const cut = t.slice(0, REPORT_MAX);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    t = (end > REPORT_MAX * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd() + "…").trim();
  }
  return t;
}

function candidatesFrom(text: string, fromUser: boolean): HeuristicMemory[] {
  const out: HeuristicMemory[] = [];
  const bias = fromUser ? 0.08 : 0;
  const tag = (sig: string[] | undefined): string[] => (fromUser ? [...(sig || []), "user"] : [...(sig || [])]);
  for (const item of extractListItems(text))
    out.push({ kind: item.kind, content: item.content, importance: Math.min(0.85, item.importance + bias), confidence: Math.min(0.98, item.confidence + bias), signal: tag(item.signals) });
  for (const sentence of splitSentences(text)) {
    const hit = classifySentence(sentence);
    if (!hit) continue;
    // A fact needs a person's words: agent prose with a path or a version in
    // it is mostly narration.
    if (hit.kind === "fact" && !fromUser) continue;
    out.push({ kind: hit.kind, content: sentence, importance: Math.min(0.85, hit.importance + bias), confidence: Math.min(0.98, hit.confidence + bias), signal: tag(hit.signals) });
  }
  for (const m of extractCodeSignals(text))
    out.push({ ...m, importance: Math.min(0.8, (m.importance || 0.5) + bias), confidence: Math.min(0.95, (m.confidence || 0.6) + bias), signal: tag(m.signal) });
  return out;
}

/**
 * Tier 0 extraction without an LLM, turn by turn (see above). `conversation`
 * is one session in time order; roles: user | assistant | tool | system.
 */
export function heuristicExtract(conversation: Array<{ role: string; content: string }>): HeuristicMemory[] {
  const collected: HeuristicMemory[] = [];
  const seen = new Set<string>();
  const accept = (m: HeuristicMemory): HeuristicMemory | null => {
    const content = normalizeContent(m.content || "");
    if (content.length < 15 || content.length > 360) return null;
    if (GENERIC_RE.test(content) || noiseReason(content)) return null;
    const key = dedupeKey(content);
    if (!key || seen.has(key)) return null;
    return { ...m, content };
  };
  const keep = (list: HeuristicMemory[], limit: number): void => {
    const ok = list.map(accept).filter((m): m is HeuristicMemory => !!m);
    ok.sort((a, b) => triageCandidate(b).score - triageCandidate(a).score || scoreForRank(b) - scoreForRank(a));
    for (const m of ok.slice(0, limit)) {
      seen.add(dedupeKey(m.content));
      collected.push(m);
    }
  };

  // Index of the last agent message before each user message (or the end).
  const finals = new Set<number>();
  let lastAgent = -1;
  conversation.forEach((m, i) => {
    if (m.role === "user") {
      if (lastAgent >= 0) finals.add(lastAgent);
      lastAgent = -1;
    } else if (m.role === "assistant") lastAgent = i;
  });
  if (lastAgent >= 0) finals.add(lastAgent);

  conversation.forEach((msg, i) => {
    const text = msg.content || "";
    if (!text.trim() || msg.role === "tool") return;
    if (msg.role === "user") {
      keep(candidatesFrom(text, true), MAX_PER_TURN);
      return;
    }
    const continuation = msg.role === "system" && CONTINUATION.test(text);
    if (msg.role === "system" && !continuation) return;
    if (msg.role === "assistant" && !finals.has(i)) {
      // Mid-turn messages are mostly narration; only an explicit decision or
      // a stated error fix survives (still capped per turn).
      if (process.env.Q3_MID === "1") keep(candidatesFrom(text, false).filter((m) => (m.kind === "decision" && EXPLICIT_DECISION.test(m.content)) || m.kind === "error_fixed"), 1);
      return;
    }
    if (!continuation) {
      const report = turnReport(text);
      if (report.length >= 40 && !noiseReason(report) && !GENERIC_RE.test(report)) {
        const key = "report:" + dedupeKey(report);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push({ kind: "context", content: report, importance: 0.45, confidence: 0.7, signal: ["turn_report"], memoryClass: "working" });
        }
      }
    }
    keep(candidatesFrom(text, false), continuation ? 12 : MAX_PER_TURN);
  });
  return collected;
}

/** Kompatibilitas: `maintain heuristic-promote` kini menjalankan auto-triage
 * penuh (promote + archive noise/duplikat/expired, tercatat & bisa di-undo). */
export function promoteLegacyHeuristicDrafts(_limit = 500): { scanned: number; promoted: number; archived: number } {
  // require lazily to avoid cycle at module init
  const { runTriage } = require("./triage") as typeof import("./triage");
  const r = runTriage();
  return { scanned: r.scanned, promoted: r.promoted, archived: r.archived };
}
