/* ---------- Language noise rules ----------
 * Agent chatter ("let me check…", "want me to…", "semoga membantu") is
 * language-specific, so it lives in one data file per language next to this
 * one. Each file lists plain phrases, never regular expressions, so a new
 * language is a safe pull request for anyone who speaks it.
 *
 * Adding a language: copy en.json to <code>.json and translate the phrases.
 * Every *.json in this folder is loaded at startup (tsconfig copies them to
 * dist/), so no registration line is needed and language PRs never conflict.
 * `tests/noise-lang.test.mjs` checks every file.
 * ------------------------------------------------------------------------- */
import * as fs from "node:fs";
import * as path from "node:path";

export type PhraseAt = "start" | "anywhere";
export interface LanguageRule {
  /** Triage reason id; the same id in several languages is one rule. */
  id: string;
  /** "start": the candidate begins with the phrase; "anywhere": it contains it. */
  at: PhraseAt;
  phrases: string[];
}
export interface LanguageFile {
  language: string;
  name: string;
  rules: LanguageRule[];
}

function isLanguageFile(d: unknown): d is LanguageFile {
  const f = d as LanguageFile;
  return !!f && typeof f.language === "string" && typeof f.name === "string" && Array.isArray(f.rules) &&
    f.rules.every((r) => r && typeof r.id === "string" && (r.at === "start" || r.at === "anywhere") && Array.isArray(r.phrases));
}

/** Every language file next to this module, English first, then by code. A
 * malformed file is skipped (and reported) instead of breaking triage. */
function loadLanguageFiles(dir: string): LanguageFile[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: LanguageFile[] = [];
  for (const name of names.sort((a, b) => (a === "en.json" ? -1 : b === "en.json" ? 1 : a.localeCompare(b)))) {
    try {
      const d: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (isLanguageFile(d)) out.push(d);
      else console.warn(`[memoria] noise-lang/${name}: invalid shape, skipped`);
    } catch {
      console.warn(`[memoria] noise-lang/${name}: unreadable JSON, skipped`);
    }
  }
  return out;
}

export const LANGUAGE_FILES: LanguageFile[] = loadLanguageFiles(__dirname);

/** Lowercase, drop apostrophes and commas, single spaces. Applied to both the
 * phrases and the candidate, so "Let's", "lets" and "let’s" are the same, and
 * "okay, now" matches "okay now". */
export function normalizePhrase(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface CompiledRule {
  id: string;
  at: PhraseAt;
  phrases: string[];
}
let compiled: CompiledRule[] | null = null;
function rules(): CompiledRule[] {
  if (compiled) return compiled;
  const byKey = new Map<string, CompiledRule>();
  for (const file of LANGUAGE_FILES) {
    for (const r of file.rules) {
      const key = `${r.id}\u0000${r.at}`;
      const target = byKey.get(key) || { id: r.id, at: r.at, phrases: [] };
      for (const p of r.phrases) {
        const n = normalizePhrase(p);
        if (n && !target.phrases.includes(n)) target.phrases.push(n);
      }
      byKey.set(key, target);
    }
  }
  compiled = [...byKey.values()];
  return compiled;
}

const isWordChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_]/u.test(c);

/** First language rule the candidate matches, or null. Phrases match whole
 * words: "reading" does not match "readings", "let me" does not match "let measure". */
export function languageNoiseReason(raw: string): string | null {
  const s = normalizePhrase(raw);
  if (!s) return null;
  for (const r of rules()) {
    for (const p of r.phrases) {
      if (r.at === "start") {
        if (s.startsWith(p) && !isWordChar(s[p.length])) return r.id;
      } else {
        let i = s.indexOf(p);
        while (i >= 0) {
          if (!isWordChar(s[i - 1]) && !isWordChar(s[i + p.length])) return r.id;
          i = s.indexOf(p, i + 1);
        }
      }
    }
  }
  return null;
}
