# Handoff Proyek: Memoria — second brain offline untuk AI coding tools
> Diperbarui manual — 2026-11-24 (repo: github.com/xinzzu/Memoria, MIT)
>
> Bagian ini ditulis manual dan **di luar** marker `memoria:start/end`. Blok di
> antara marker di bawah ditimpa otomatis oleh Memoria (resume sesi); jangan
> menaruh catatan permanen di sana.

## Apa ini
App Electron + engine Node/TS yang menangkap transkrip sesi AI coding tools
(Claude Code, Codex, Gemini CLI, opencode, Copilot, Antigravity, VS Code, Cursor,
Windsurf) lalu mengubahnya jadi memori yang bisa di-recall lintas tool (MCP +
dashboard). North star: **limit-hopping** — pindah tool AI tanpa menjelaskan
ulang konteks.

## Sumber kebenaran
- `CHANGELOG.md` — riwayat rilis (English).
- `ROADMAP.md` — bagian **"POSISI TERKINI"** = status + backlog berurutan.
- `git log` — conventional commits; fitur via branch `feat/...`/`fix/...`/`chore/...`
  → PR ke `main` → tunggu check `verify` → merge commit (`--merge`, bukan squash).

## Status (v0.16.3, 2026-11-22)
- Rilis terbaru: **v0.16.3**. Distribusi: npm `@xinzzu/memoria`, MCP Registry
  `io.github.xinzzu/memoria`, Glama, mcprush, GitHub Releases (installer 3 OS),
  landing page https://memoria.xinzzu.web.id (`site/`, GitHub Pages).
- Selesai sejak v0.12: Tier 0 auto-triage + polish, redaksi secret, migrasi
  v8/v9/v10 (`superseded_by`), token API lokal, secret CLI terenkripsi (keychain),
  parser VS Code/Cursor, onboarding, hook Claude Code, import ChatGPT/Claude zip,
  Obsidian dua arah, sync M5 (rotate/revoke/clock guard), team brain
  (`.memoria/brain.md`), anotasi tool MCP, SDK MCP 1.32.2 (0 advisory produksi).
- Kontributor luar: @bhavana4123 (README Hindi), @StreamLine-18 (landing),
  @jamesyshd19-cmyk (CLI unknown command).

## Arsitektur singkat
- `src/engine/` — inti (tsc, commonjs, output `dist/engine/`): `store/db.ts`
  (node:sqlite, WAL, migrasi `PRAGMA user_version`), `sync/`, `retrieve/`
  (FTS5 trigram + embedding + graph), `extract/` (heuristik/Ollama/OpenAI-compat,
  triage, noise, supersede), `ingest/` (watcher + parser per tool), `handoff.ts`
  (blok resume ber-marker ke AGENTS/CLAUDE/GEMINI.md), `mcp/` (stdio + HTTP
  `/mcp`, 9 tool), `team/brain.ts`, `privacy/redact.ts`, `auth.ts`.
- `web/` — dashboard vanilla JS (app.js + i18n.js); SSE live update.
- `src/electron/` — main process (tray, shortcut, safeStorage).
- `site/` — landing page statis; deploy `.github/workflows/pages.yml`
  (aktif lewat variable `SITE_ENABLED`, domain di `site/CNAME`).

## Perintah penting
- `npm run build` · `npm test` (build + `node --test`, **jalan terhadap dist/**;
  file test baru wajib didaftarkan di `scripts.test` package.json) ·
  `npm run check:ui` · `npm run check:versions` · `npm run eval:heuristic`.
- **Terisolasi (JANGAN sentuh ~/.memoria asli):**
  `HOME=$(mktemp -d) MEMORIA_DATA_DIR=$(mktemp -d) node dist/engine/index.js server`
  (port lain: `MEMORIA_HTTP_PORT`). Perintah CLI apa pun tanpa `MEMORIA_DATA_DIR`
  membuka DB asli.
- Rilis: branch `chore/release-vX` → `npm version X --no-git-tag-version` →
  potong `[Unreleased]` di CHANGELOG → badge status di **semua** README
  (EN/ID/HI) + versi `server.json` (dicek `check:versions`) → PR → merge →
  `git tag -a vX && git push origin vX`. CI: verify → npm (trusted publishing) →
  MCP Registry (OIDC) → build 3 OS → GitHub Release (menunggu npm).

## Gotcha
- node:sqlite mengembalikan objek null-prototype — akses properti eksplisit.
- `closeDb()` membersihkan memo id proyek; jangan cache id lintas handle DB.
- Peran transkrip: `tool` = output tool (dilewati ekstraksi), `system` = meta.
- Aturan noise struktural (shell/kode/output tool) → `NOISE_RULES` di `extract/noise.ts`;
  obrolan agen per bahasa → frasa di `extract/noise-lang/<lang>.json` (bukan regex,
  daftarkan di `index.ts`). Tambah contoh di `tests/fixtures/heuristic-eval.json`
  → `npm run eval:heuristic`. Pola noise pengguna = substring, bukan regex.
- `#overlay`/`#toast-wrap` wajib anak langsung `<body>` (dijaga `check:ui`).
- Kolom/field sync baru: field payload memori **opsional**; versi lama mengabaikan
  field asing, dan apply hanya menimpa field yang ada di payload. Cek dua arah
  dengan rilis lama: `npm pack @xinzzu/memoria@<lama>` → `node scripts/compat-sync.mjs package/dist`.
- `session_events` (lokal, tidak di-sync) — tulis lewat `insertSessionEvent`, unik per `(tool, session_id, source_ref)`.
- String UI: English sebagai kunci `t()`, terjemahan di `web/i18n.js`; tanpa emoji.
- Repo, kode, PR, CHANGELOG, README.md: English. README.id.md, ROADMAP.md,
  AGENTS.md: Indonesia.
- Glama memakai Build steps `npm install -g @xinzzu/memoria@latest` + Auto-Release;
  nomor versi Glama bisa mendahului npm (ada 0.16.4 di Glama) — rilis berikutnya 0.17.0.

## Next
**Fase kualitas v0.17.0 (fitur dibekukan).** Rencana lengkap 25 langkah, aturan
main, dan gerbang angka: `ROADMAP.md` → POSISI TERKINI. Ringkas:
- Setiap PR kualitas wajib angka sebelum/sesudah (eval privat `.eval-private/`).
- Fokus Claude Code + opencode; capture event terstruktur (todo, pertanyaan,
  error→fix dari **isi output**, file, commit) sebelum menyentuh heuristik kalimat.
- Kolom baru di `memories` selalu opsional; event mentah tidak pernah di-sync.
- Refactor `db.ts`/`http.ts`/`app.js` dan fitur baru dibekukan sampai v0.17.0.

<!-- memoria:start -->
_(Blok resume otomatis Memoria akan muncul di sini.)_
<!-- memoria:end -->
