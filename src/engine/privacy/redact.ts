/* ---------- Redaksi secret (privasi lokal) ----------
 * Dijalankan di titik masuk data (insertTranscript / insertMemory /
 * updateMemory) agar secret yang tercetak di sesi AI tidak pernah tersimpan,
 * ikut ke blok resume AGENTS.md/CLAUDE.md, atau terkirim ke endpoint Tier 2.
 *
 * Desain: daftar pola eksplisit (provider token berformat jelas) + pola
 * key=value untuk nama variabel sensitif + blok <private>…</private> yang
 * ditandai user. Sengaja TIDAK memakai deteksi entropi murni: hash commit,
 * UUID, dan alamat publik terlalu sering jadi false positive di sesi coding.
 * Diukur ulang (2026-11-24) pada salinan DB nyata: dari 256 token
 * ber-entropi tinggi, praktis semuanya alamat Solana/EVM publik, signature
 * transaksi, nama modul CSS, atau SVG base64 — tidak dipakai. Yang lolos
 * justru 26 private key hex 32-byte berlabel → aturan hex-private-key.
 * ------------------------------------------------------------------------- */

export interface RedactResult {
  text: string;
  count: number;
}

interface SecretRule {
  name: string;
  re: RegExp;
  /** Indeks grup yang berisi secret; 0 = seluruh match. */
  group?: number;
}

const MASK = (name: string) => `[REDACTED:${name}]`;

// Urutan: pola spesifik dulu (agar label akurat), lalu pola generik.
const RULES: SecretRule[] = [
  { name: "private-key", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g },
  { name: "anthropic", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "openai", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: "github", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: "gitlab", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "google-api", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { name: "discord-webhook", re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g },
  { name: "telegram-bot", re: /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}\b/g },
  { name: "stripe", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: "huggingface", re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: "npm", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // user:password@host di connection string (postgres://, mysql://, mongodb+srv://, redis://, amqp://)
  { name: "conn-password", re: /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql):\/\/[^:\s/@]+:)([^@\s]{3,})(@)/gi, group: 2 },
  // Bearer token di header
  { name: "bearer", re: /\b(Authorization:\s*Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi, group: 2 },
  // 32-byte hex key next to a label that says what it is: `Private key: 0x…`,
  // `process.env.PRIVATE_KEY || '0x…'`, `privateKeyToAccount("0x…")`. Bare
  // 64-hex strings are mostly transaction hashes, so the label is required.
  {
    name: "hex-private-key",
    re: /((?:private[_ -]?key|privateKey\w*|secret[_ -]?key|signer[_ -]?key|deployer[_ -]?key|mnemonic)[^\n]{0,40}?)((?:0x)?[0-9a-fA-F]{64})(?![0-9a-fA-F])/gi,
    group: 2,
  },
  // Solana / ed25519 keypair file: a JSON array of exactly 64 bytes.
  { name: "keypair-bytes", re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g },
  // NAMA_SENSITIF=nilai / "apiKey": "nilai" / password: nilai
  {
    name: "secret-assignment",
    // Nama harus BERAKHIR dengan kata kunci (API_KEY, dbPassword, accessToken),
    // jadi `tokenizer:`/`max_tokens=` tidak ikut tertangkap.
    re: /((?:^|[\s"'`{,(])(?:[A-Za-z0-9_-]*?(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|private[_-]?key|access[_-]?key|auth[_-]?key|mnemonic|seed[_-]?phrase))["']?\s*[:=]\s*["']?)([^\s"'`,;}{()]{6,})/gi,
    group: 2,
  },
];

/** Nilai yang jelas bukan secret (placeholder/rujukan env) — jangan disensor. */
function isPlaceholder(v: string): boolean {
  if (/^\$\{?[A-Z_][A-Z0-9_]*\}?$/.test(v)) return true; // $VAR / ${VAR}
  if (/^process\.env\./.test(v) || /^os\.environ/.test(v) || /^env\(/i.test(v)) return true;
  if (/^(?:x{3,}|\*{3,}|<[^>]+>|\.{3,}|your[_-]|changeme|example|placeholder|dummy|test|true|false|null|undefined|none|redacted)/i.test(v)) return true;
  if (/^\[REDACTED/.test(v)) return true;
  if (/^(?:string|number|boolean|any|unknown|optional|required)\b/i.test(v)) return true; // anotasi tipe
  if (/^https?:\/\//i.test(v)) return true; // URL endpoint, bukan nilai rahasia
  // Alamat EVM (20 byte) itu publik. Private key (32 byte / 64 hex) TETAP disensor.
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return true;
  // Identifier polos tanpa digit/simbol & pendek = kemungkinan besar nama
  // variabel/fungsi (`token = getToken`), bukan secret.
  if (v.length < 16 && /^[A-Za-z_.]+$/.test(v)) return true;
  return false;
}

const PRIVATE_BLOCK = /<private>[\s\S]*?(?:<\/private>|$)/gi;

/** Sensor secret + blok <private>. Idempoten (aman dijalankan ulang). */
export function redactSecrets(input: string): RedactResult {
  if (!input) return { text: input, count: 0 };
  let count = 0;
  let text = input.replace(PRIVATE_BLOCK, () => {
    count++;
    return MASK("private");
  });
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    text = text.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string;
      if (rule.group == null || rule.group === 0) {
        count++;
        return MASK(rule.name);
      }
      const groups = args.slice(1, -2) as Array<string | undefined>;
      const secret = groups[rule.group - 1];
      if (!secret || isPlaceholder(secret)) return match;
      count++;
      const prefix = groups.slice(0, rule.group - 1).join("");
      const suffix = groups.slice(rule.group).filter((g) => typeof g === "string").join("");
      return prefix + MASK(rule.name) + suffix;
    });
  }
  return { text, count };
}
