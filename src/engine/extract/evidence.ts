/* Evidence score (quality phase Q4).
 *
 * A logistic regression over features of a candidate memory, fitted offline
 * on 296 owner-labelled memories from a real library (tuning set) and checked
 * on 650 held-out labels it never saw. On the held-out labels, against the
 * Tier 0 triage score alone: active precision 38.8% → 45.0%, memories kept
 * 79.5% → 83.3%, noise removed 78.1% → 78.7%, real memories active 26 → 45
 * of 78. Thresholds were chosen on the tuning set only: `archive` keeps the
 * tuning set's noise removal equal to the old triage, `active` is the lowest
 * probability with ≥70% precision there.
 *
 * Signals the labels cannot teach (they did not exist yet) are applied as
 * small adjustments on top: a "not relevant" mark from the retrieval
 * inspector, a memory agents keep fetching, and evidence from a structured
 * session event. */
import { letterRatio, wordCount } from "./noise";

const KINDS = ["fact", "decision", "task_done", "task_pending", "error_fixed", "preference", "context"];

/** Fitted weights, same order as `features()`. */
const W = [-0.305, 1.263, -2.34, 0.299, -0.121, -0.796, -1.171, 1.167, 0.532, 0, 0.372, 0.347, 0.16, -1.08, 1.644, -0.317, 0.348, -0.222, 0.855, 0.346, 0.834, -0.137];
export const ARCHIVE_BELOW = 0.415;
export const ACTIVE_FROM = 0.807;

export interface EvidenceInput {
  kind: string;
  content: string;
  /** Tier 0 triage result for the same candidate. */
  triage: { score: number; decision: string; signals: string[] };
}

export function features(m: EvidenceInput): number[] {
  const c = m.content.replace(/\s+/g, " ").trim();
  const words = wordCount(c);
  return [
    1,
    m.triage.score,
    m.triage.decision === "archive" ? 1 : 0,
    ...KINDS.map((k) => (m.kind === k ? 1 : 0)),
    Math.log1p(c.length) / 6,
    Math.min(words, 40) / 40,
    letterRatio(c),
    /\?\s*$/.test(c) ? 1 : 0,
    /`[^`]+`/.test(c) ? 1 : 0,
    /\b[\w-]+\/[\w./-]+\.\w{1,5}\b/.test(c) ? 1 : 0,
    /\*\*/.test(c) ? 1 : 0,
    /^\s*[-*\d]/.test(m.content) ? 1 : 0,
    /\b(karena|supaya|because|so that|instead of|daripada)\b/i.test(c) ? 1 : 0,
    /^(saya|aku|sekarang|oke|ok|let me|now i|i'll|i will|i've)\b/i.test(c) ? 1 : 0,
    m.triage.signals.includes("decision") ? 1 : 0,
    m.triage.signals.includes("entity") ? 1 : 0,
  ];
}

const SELF_LABELLED = /^\s*(?:[-*]\s*)?(?:todo|to-do|fixme|keputusan|decision|decided)\s*:/i;

export interface RuntimeSignals {
  /** "Not relevant" marks from the retrieval inspector. */
  irrelevantMarks?: number;
  /** Times an agent fetched it (recall / get_memory / file_context). */
  accessCount?: number;
  /** Built from a structured session event (todo, verifier run, commit). */
  fromEvent?: boolean;
}

export function evidenceProbability(m: EvidenceInput, rt: RuntimeSignals = {}): number {
  const f = features(m);
  let z = 0;
  for (let i = 0; i < W.length; i++) z += W[i] * f[i];
  let p = 1 / (1 + Math.exp(-z));
  // Not learned (no labels yet): small, bounded adjustments. Credit first,
  // then a "not relevant" mark, so a mark always lowers the result.
  // A line that labels itself ("TODO: …", "Keputusan: …") states its kind;
  // the tuning labels hold too few of these to learn it.
  if (SELF_LABELLED.test(m.content)) p += 0.4;
  if (rt.accessCount) p += Math.min(0.1, 0.03 * Math.log1p(rt.accessCount));
  if (rt.fromEvent) p += 0.15;
  p = Math.min(1, p);
  if (rt.irrelevantMarks) p -= Math.min(0.45, 0.2 * rt.irrelevantMarks);
  return Math.max(0, Math.min(1, p));
}

export function evidenceDecision(p: number): "active" | "draft" | "archive" {
  return p >= ACTIVE_FROM ? "active" : p < ARCHIVE_BELOW ? "archive" : "draft";
}
