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

## Status (main, 2026-11-24 — belum dirilis; rilis berikutnya v0.17.0)
- Rilis terbaru: **v0.16.3**. Distribusi: npm `@xinzzu/memoria`, MCP Registry
  `io.github.xinzzu/memoria`, Glama, mcprush, GitHub Releases (installer 3 OS +
  `SHA256SUMS.txt`), landing page https://memoria.xinzzu.web.id.
- Fase kualitas (PR #102–#118) sudah di `main`: peran transkrip lama (v11),
  retrieval inspector (v12), `session_events` + metadata memori (v13), todo /
  pertanyaan / verifier / commit sebagai event, backfill, ekstraksi per giliran,
  skor bukti, lifecycle, retensi + redaksi kunci (v14), tool lite, kesehatan
  capture, `memoria doctor`, `PRIVACY.md`.
- Gerbang langkah 17: kalimat Tier 0 tidak bisa ≥70% → pemilik memilih tanpa
  LLM: promosi `structured` (set proaktif 95,6% dari event). Rilis v0.17.0
  menunggu "boleh rilis" (README diposisikan sebagai alat serah terima kerja).
- Kontributor luar: @bhavana4123 (README Hindi), @StreamLine-18 (landing),
  @jamesyshd19-cmyk (CLI unknown command), @daocuong11 (komentar handoff.ts).

## Arsitektur singkat
- `src/engine/` — inti (tsc, commonjs, output `dist/engine/`): `store/db.ts`
  (node:sqlite, WAL, migrasi `PRAGMA user_version`), `sync/`, `retrieve/`
  (FTS5 trigram + embedding + graph), `extract/` (heuristik/Ollama/OpenAI-compat,
  triage, noise, supersede, `events.ts` event→memori, `evidence.ts` skor bukti,
  `expire.ts` lifecycle), `ingest/` (watcher + parser per tool, `events.ts`
  parsing event, `health.ts`, `backfill.ts`), `store/retention.ts`, `doctor.ts`, `handoff.ts`
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
- Peran transkrip: `tool` = output tool (dilewati ekstraksi), `system` = meta
  (ringkasan lanjutan sesi dibaca Tier 0). Baris Claude lama diperbaiki M11.
- Tier 0 membaca **per giliran** (`heuristicExtract` dapat satu sesi utuh):
  pesan agen di tengah giliran dilewati; pesan akhir → laporan giliran
  `context`/`working` (kedaluwarsa 3 hari) + kandidat. Keputusan triage =
  `evidenceTriage` (regresi logistik di `extract/evidence.ts`; bobot dilatih
  offline dengan `.eval-private/q4-lr.mjs` — jangan setel di data held-out).
- Memori `working` punya `expires_at`; `retireExpired()` jalan sebelum konteks
  disajikan. Jangan menyajikan memori working tanpa lewat jalur itu.
- Event terstruktur → `session_events` lewat `insertSessionEvent` (unik per
  `(tool, session_id, source_ref)`, payload diredaksi per nilai), lalu
  `materializeEvents` (kursor `eventsProcessedId`). Gagal/lulus verifier dibaca
  dari **isi output**, bukan exit code.
- **Server / app pada salinan DB nyata wajib `MEMORIA_NO_INJECT=1`**: path proyek
  di DB adalah folder asli, jadi HOME palsu tidak mencegah injeksi blok resume.
- Pengujian yang membaca sumber asli: panggil parser langsung (`scanClaude`,
  `scanOpencode`, `backfillEvents`). **Jangan `scanAll` dengan HOME asli** —
  sinyal limit menulis blok resume ke file proyek sungguhan.
- Promosi Tier 0: `tier0Promote = structured` (bawaan) — kalimat heuristik tetap
  draft; yang aktif hanya event/berlabel diri/`remember`/terkonfirmasi. `recall`
  memakai `includeDrafts: true`; resume & `project_context` tidak. Alasan: gerbang
  langkah 17 (ketepatan kalimat Tier 0 tidak bisa ≥70%).
- Mode tool MCP: `MEMORIA_MCP_TOOLS=lite|full` atau setting `mcpTools`;
  batas output bawaan di `DEFAULT_CAPS` (`mcp/server.ts`).
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
- **Rilis wajib full English** (keputusan pemilik): semua yang tampil di rilis
  publik — CHANGELOG (termasuk header & seksi lama), body PR rilis, subjek
  commit (masuk ke body GitHub Release lewat `build.yml`), pesan tag, metadata
  paket (`description`, `synopsis` di package.json, `server.json`), teks
  default UI (EN; terjemahan ID hanya lewat `web/i18n.js`). Sebelum tag,
  cek tidak ada kalimat Indonesia di seksi CHANGELOG versi itu dan di
  `git log vPrev..HEAD`. Komentar kode Indonesia lama boleh tetap.
- Glama memakai Build steps `npm install -g @xinzzu/memoria@latest` + Auto-Release;
  nomor versi Glama bisa mendahului npm (ada 0.16.4 di Glama) — rilis berikutnya 0.17.0.

## Next
**Fase kualitas v0.17.0 (fitur dibekukan) — sebagian besar selesai, gerbang gagal (lihat Status).** Rencana lengkap 25 langkah, aturan
main, dan gerbang angka: `ROADMAP.md` → POSISI TERKINI. Ringkas:
- Setiap PR kualitas wajib angka sebelum/sesudah (eval privat `.eval-private/`).
- Fokus Claude Code + opencode; capture event terstruktur (todo, pertanyaan,
  error→fix dari **isi output**, file, commit) sebelum menyentuh heuristik kalimat.
- Kolom baru di `memories` selalu opsional; event mentah tidak pernah di-sync.
- Refactor `db.ts`/`http.ts`/`app.js` dan fitur baru dibekukan sampai v0.17.0.

<!-- memoria:start -->
_(Blok resume otomatis Memoria akan muncul di sini.)_
<!-- memoria:end -->
