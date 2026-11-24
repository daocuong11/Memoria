# Memoria — Rencana Pengerjaan (Eksekusi v1)

> Disusun: 2026-11-03 · Basis: v0.1.0-beta (commit 26e1cef)
> North star: **Limit-hopping continuity** — nol kalimat pengantar ulang saat pindah tool AI.

---

## ⏭ POSISI TERKINI (2026-11-24) — fase kualitas v0.17.0

**Rilis terbaru: v0.16.3.** Di `main` sudah ada (belum dirilis): jurnal belajar,
tombol Sync (devices/rotate/revoke), file noise per bahasa, cakupan repo git,
dedup hook CLAUDE.md, aturan Tier 0 yang diukur di data nyata.

**Keputusan rilis (2026-11-24): satu rilis di akhir.** Tidak ada rilis di
tengah fase. Semua isi `main` di atas + hasil fase kualitas keluar bersama
sebagai **v0.17.0** (langkah 25). Langkah 3 (klaim README/landing) dan 4
(rilis v0.17.0) digabung ke langkah 25; README dan landing tidak disentuh
sampai saat itu.

**Arah baru (2026-11-24):** fitur dibekukan; 3–4 minggu fokus ke **kualitas
inti**. Dasarnya analisis di data nyata (read-only, label privat di
`.eval-private/`): ketepatan memori yang otomatis aktif baru 41% (rentang 95%:
25–59%), noise terbuang 70%; 19 dari 32 memori bagus tidak aktif sehingga
recall hit@5 hanya 34%; todo opencode yang tertangkap 1% (1/92); jawaban
`AskUserQuestion` diarsipkan sebagai noise; embedding 100% `hash-256-v1`
(tidak semantik); definisi 9 tool MCP ≈1.600 token. Error→fix tanpa LLM layak
(≈94% tepat) **asal kegagalan dibaca dari isi output** — 95% perintah build/test
memakai pipe sehingga exit code tertutup.

### A. Aturan main
1. Setiap PR kualitas mencantumkan angka sebelum/sesudah; angka tidak naik =
   tidak di-merge. Test ikut di PR yang sama.
2. **Dibekukan:** refactor `db.ts`/`http.ts`/`app.js`, i18n multi-bahasa,
   bagian Contributors, Homebrew/winget, code signing, integrasi/fitur baru.
   Graph 3D, Obsidian, webhook, team brain diberi label "experimental".
3. **Fokus tool:** Claude Code + opencode (ada event terstruktur dan datanya).
   Codex **ditunda, bukan dicoret** (butuh fixture); Gemini/Antigravity ditunda.
4. Pengujian read-only / salinan DB; label & data turunan sesi hanya di
   `.eval-private/`; contoh di repo ditulis ulang tanpa isi pribadi.
5. **Kompatibilitas sync:** pakai jenis memori yang ada, metadata baru = kolom
   opsional, event mentah tidak pernah di-sync, ada test bundle versi baru bisa
   diterapkan versi lama.
6. Promosi menunggu v0.17.0.
7. Perkiraan 3–4 minggu, batas keras 4 minggu. Gerbang gagal → Memoria
   diposisikan sebagai **alat serah terima kerja lintas tool**, README ikut.
8. PR kontributor (#81/#82) di-merge duluan; kerja kita yang menyesuaikan.

### B. Langkah (S = maintainer/agen, A = pemilik)

**Minggu 0 — beres-beres & dasar ukur**
1. Q0a ROADMAP/AGENTS diperbarui (dokumen ini). — S
2. Q0b Catatan di issue #81/#82. — S
3. Q0c Klaim README (EN/ID/HI) + landing dilunakkan; fitur non-inti "experimental". — S
4. Q0d Rilis v0.17.0. — S, **A: "boleh rilis"**
5. Q-eval1 Held-out diperbesar: ≥60 memori asli **dan ≥90 prediksi aktif** (rentang ≤ ±10 poin). — S
6. Q-eval2 50 label acak dicek orang kedua. — **A** (±15 menit)
7. Q-eval3 Query recall 32 → 50 (ID/EN, lintas bahasa); ukur kondisi (a) sekarang dan (b) promosi ideal. — S
8. Q-eval4 Protokol uji serah terima 10 menit (Claude Code → opencode). — S tulis, **A jalankan**

**Minggu 1 — capture yang benar**
9. Q1 Perbaiki peran data lama (≥1.743 baris tool tercatat `user`), snapshot dulu, triage ulang. Target noise terbuang +5 poin. — **Hasil di Q1 di bawah.**
10. Q1.5 Retrieval inspector: log lokal (≤500 entri, diredaksi, tidak di-sync) + tab dashboard + "tandai tidak relevan".
11. Q2-schema Migrasi v12: tabel lokal `session_events` (tidak di-sync); kolom opsional di `memories`: `source_event_id`, `git_branch`, **`git_commit`**, `memory_class` (`working`/`durable`), `expires_at`; test kompatibilitas bundle.
12. Q2a Todo (`TodoWrite`/`Task*`/`update_plan`, opencode `todowrite`/`todo`) dengan status asli; jawaban pertanyaan bersubstansi → `decision`, persetujuan sesaat → working; judul `ai-title`/`session.title`, recap `wrap_up`. Target todo tertangkap ≥90%.
13. Q2b Error→fix: allowlist verifier, gagal dari **isi output** (+exit code), normalisasi perintah, wajib baris error + file kode; verifier gagal di akhir sesi → task "belum beres"; file dari Edit/Write; commit `fix:`/`feat:`; branch + commit; redaksi stdout/stderr. Target ketepatan ≥90% (semua pasangan lolos filter ±46 + 20 yang ditolak).
14. Q-backfill Proses ulang 28 sesi Claude + 52 sesi opencode, idempoten.

**Minggu 2 — promosi yang bersih**
15. Q3 Laporan penutup giliran = satu laporan `working` (tidak dipecah per kalimat); narasi tengah giliran dilewati; `fact` hanya dari ucapan user berentitas; ≤3 kandidat/giliran; penanda kuat ID/EN; ekstraksi ulang transkrip lama. Target noise terbuang ≥85%.
16. Q4 Skor berbasis bukti (sumber, ditopang event, corroboration, file masih ada, penanda kuat, pernah dipakai) + **sinyal negatif** (`update_memory`, `forget`, arsip manual, tandai tidak relevan); kalibrasi regresi logistik offline. Target memori bagus terjangkau ≥26/32.
17. **Gerbang** sampel buta baru: ketepatan ≥70%, noise terbuang ≥85%, memori tersimpan ≥90% (rentang ≤ ±10). — S, **A cek 30 label**

**Minggu 3–4 — tahan lama, hemat, siap promosi**
18. Q5 Lifecycle: `working` kedaluwarsa 3–7 hari / saat task selesai; `durable` decay bila tak dipakai; cek ke kode (path hilang → stale, churn sejak `git_commit` → mungkin usang, branch lain → turun sedikit); commit menutup task. Target memori basi disajikan <5%.
19. Q6 Retensi: **arsip terkompresi lokal (bawaan)**, hapus permanen opsional; sesi terakhir per proyek utuh; entropi di redaksi.
20. Q7 Mode tool lite (3 tool, <600 token); **batas token bawaan untuk semua tool** (`recall`, `project_context`, `build_context`, `file_context`, tetap bisa `maxChars`); susunan resume baru; penanda `(stale)`/`(maybe outdated)`/`(from event)`; cek pembacaan ulang file konteks di tengah sesi. Target token/sesi <1.200.
21. Q8 Kesehatan capture per tool, isolasi parser, fixture jsonl + `opencode.db`; issue `help wanted` untuk fixture Codex.
22. Q9a Embedding semantik: `nomic-embed-text` (Ollama) vs `multilingual-e5-small` in-process vs `all-MiniLM-L6-v2`. Target hit@5 (a) ≥70%, (b) ≥80%. — **A pilih model**
23. Q9b LLM opsional: nilai draft ragu, padatkan laporan giliran, konsolidasi keputusan; fallback Tier 0. Target ketepatan ≥85%.
24. Q9.5 `memoria doctor`, snapshot sebelum migrasi, checksum SHA256 di release, `PRIVACY.md`.
25. Q10 Rilis v0.17.0 "Quality": README dengan angka gerbang + positioning (claude-mem, OpenMemory/mem0, Basic Memory, memori bawaan Claude Code) + siapa yang cocok/tidak. — **A: "boleh rilis"**

**Sesudah v0.17.0:** usulan ADR (`docs/adr/`), export JSONL lewat CLI, filter &
file konflik Obsidian, refactor, parser Codex/Gemini, i18n/Contributors/
Homebrew/winget/code signing. **Tidak diambil:** grup proyek lintas repo, MCP
Resources, parameter `feedback` di tool MCP, compaction tanpa LLM.

### C. Target gerbang v0.17.0
| Metrik | Sekarang | Target |
|---|---|---|
| Ketepatan memori aktif | 38% (24–53%), held-out v2 | ≥70% Tier 0, ≥85% + LLM |
| Noise terbuang | 80% (77–84%), held-out v2 | ≥85% |
| Memori asli tersimpan | 75% (62–84%), held-out v2 | ≥90% |
| Memori bagus terjangkau | 13/32 | ≥26/32 |
| Recall hit@5 (a) sekarang / (b) promosi ideal | 26% / 72% (50 query) | ≥70% / ≥80% |
| Todo tertangkap | 1% | ≥90% |
| Ketepatan error→fix | ≈94% (sampel, belum diimplementasi) | ≥90% |
| Memori basi disajikan | belum diukur | <5% |
| Token per sesi (tool + resume) | ≈2.000 | <1.200 |
| Kesehatan capture | belum ada | ada per tool |
| Uji serah terima | baseline langkah 8 | tak ada task/keputusan aktif hilang |

### C2. Baseline Q-eval (2026-11-24)
Sampel buta baru **held-out v2**: 500 memori heuristik acak, dilabel sebelum
classifier jalan (55 memori asli). Tidak dipakai untuk menyetel aturan.

| Metrik | Held-out v1 (150) | **Held-out v2 (500)** | Rentang 95% v2 |
|---|---|---|---|
| Ketepatan memori aktif | 41% (11/27) | **38% (15/40)** | 24–53% |
| Noise terbuang | 70% | **80% (358/445)** | 77–84% |
| Memori asli tersimpan | 91% (21/23) | **75% (41/55)** | 62–84% |
| Recall hit@5, 50 query: (a) sekarang / (b) promosi ideal | — | **26% / 72%** (MRR 0,23 / 0,61) | — |

**Belum tercapai:** ≥90 prediksi aktif (baru 40) — rentang ketepatan masih
±15. Ditambah di gerbang (langkah 17) dengan sampel yang lebih besar.

**Kehilangan memori di v2 (14 dari 55), penyebabnya:**
- Pesan commit dibuang aturan `git-output` (3) → ditangani sebagai event di Q2b.
- Baris konfigurasi/endpoint (`*_RPC_URL=…`, `**Endpoint:**`) dibuang `too-few-words` (5).
- Baris tabel bermakna dibuang `table-row` (2).
- Regresi aturan baru: frasa `berarti` (`user-request`) dan `dangling-colon` (2) → diperbaiki di Q1/Q3.

### C3. Hasil Q1 — peran data lama (migrasi v11)
Migrasi v11 `legacy-claude-roles` menilai ulang baris Claude `user` dari sesi
yang ditulis parser lama (sesi tanpa satu pun baris `tool`); sesi parser baru
dan tool lain tidak disentuh. Sebelum migrasi apa pun, DB disalin ke
`backups/memory-pre-v<N>-<waktu>.db` (sebagian langkah 24).

Diuji di salinan DB nyata, kebenaran dari 8.068 baris yang jsonl aslinya masih ada:

| Metrik | Sebelum | Sesudah |
|---|---|---|
| Baris Claude `user` (10.318) | 10.318 | 1.814 user · 7.765 tool · 739 system |
| Output tool yang keluar dari `user` | 0% | 96,9% (6.178/6.374) |
| Pesan manusia yang tetap `user` (di luar penanda gambar/IDE/interupsi) | 100% | 96,9% (1.080/1.115) |
| Ketepatan label `user` | 21% (1.694/8.068) | 85% (1.080/1.276) |
| "Permintaan user terakhir" per sesi benar (snapshot/resume) | 5/15 | 13/14 |
| Task ditandai selesai hanya karena output tool | 8 dari 78 | 0 |
| Waktu migrasi (DB 39 MB, termasuk snapshot) | — | 2,5 dtk |

**Target noise terbuang +5 poin belum tercapai.** Eval held-out menilai isi
memori saja, jadi angkanya tetap (v2: 38% / 80% / 75%). Dicoba: arsipkan
memori yang isinya hanya muncul di baris tool (2.577 memori belum diarsip; di
held-out v2 259 dari 271 = 95,6% noise). Hasil di v2: noise terbuang +3,2 poin tetapi
memori asli tersimpan −1,8 (arsip semua: +4,5 / −9,0) — memori bagus ikut
hilang (pesan commit, baris env, kalimat dokumen yang dibaca tool). **Tidak
diambil.** Asal "tool" masuk sebagai fitur di skor bukti (Q4); pengurangan
noise dari peran yang benar baru terlihat saat ekstraksi ulang (Q3/backfill).

Regresi `berarti`/`dangling-colon` tidak diubah: di data penyetelan
(446 label) semua kasusnya noise, jadi mengubahnya hanya demi v2 = menyetel di
data uji. Dibahas lagi di Q3 dengan sampel baru.

### D. Audit eksternal 24 poin (sudah dicek ke kode)
Sudah ada: WAL+busy_timeout, supersede, dedupe saat tulis, redaksi secret,
proteksi port lokal (token/Host/CORS), benchmark. Masuk rencana: embedding
in-process (22), isolasi parser (21), doctor+snapshot (24), inspector (10),
PRIVACY+checksum (24). Sebagian: branch/commit (11,13,18), decay (18), ekstraksi
git (13,15), tool bloat & batas token & KV-cache (20), feedback (10,16).
Ditunda: konflik/filter Obsidian, export JSONL. Tidak diambil: grup lintas repo.
Tidak berlaku: loop CLAUDE.md, CPU watcher (watcher tidak memantau folder proyek).

**Catatan lingkungan:** pengujian selalu terisolasi
(`HOME=$(mktemp -d) MEMORIA_DATA_DIR=$(mktemp -d)`); DB asli `~/.memoria` hanya
dipakai app atau dibaca read-only (`file:…?mode=ro&immutable=1`). Ukur konteks:
`node scripts/audit-context.mjs`. Eval privat: `.eval-private/` (git-ignored).

---

## 0. Ringkasan Eksekutif

Memoria = second brain offline untuk semua AI coding tool. Rencana ini menyatukan:
(1) perbaikan bug kritis, (2) **Resume Engine** untuk skenario limit-hopping,
(3) **Tiered Intelligence** agar Ollama jadi opsional, (4) performa & RAM,
(5) design dashboard, (6) ekspansi.

| Fase | Tema | Estimasi | Prioritas |
|------|------|----------|-----------|
| **F0** | Fondasi: keamanan + bug kritis | 2–3 hari | 🔴 P0 — pintu masuk semua fase |
| **F1A** | Resume Engine (limit-hopping) | 5–7 hari | 🔴 P0 — jantung use case |
| **F1B** | Tiered Intelligence (Ollama opsional) | 5–7 hari | 🟠 P1 — penyebab onboarding friction |
| **F1C** | Retrieval & Skala (FTS5, BLOB, batch) | 3–4 hari | 🟠 P1 — prasyarat skala |
| **F2** | Dashboard design & UX | 5–7 hari | 🟡 P2 |
| **F3** | Ekspansi (webhook, sync, test, signing) | fleksibel | 🟢 P3 |

Urutan eksekusi: **F0 → F1A → F1B → F1C → F2 → F3.**
Alasan: F0 memperbaiki fondasi yang bocor; F1A menjawab keresahan asal produk;
F1B membuka gerbang user baru; F1C & F2 menyempurnakan; F3 menumbuhkan.

---

## 1. North Star & Prinsip Desain

### Skenario pengujian utama (litmus test)
> Kerja di Claude Code pukul 14:00, limit habis 14:30, buka Codex/opencode/Gemini
> pukul 14:31 di proyek yang sama → **tool baru langsung tahu**: daftar pekerjaan
> terakhir, keputusan terkunci, file yang terakhir disentuh — tanpa user menjelaskan ulang.

Setiap fitur baru wajib menjawab: *"Apakah ini mempercepat momen pindah tool itu?"*

### Prinsip
1. **Capture never blocked** — ingest transkrip tidak pernah butuh model apapun.
2. **Degradasi berjenjang, tidak pernah diam** — tanpa Ollama ≠ tanpa memori.
3. **Privasi eksplisit** — default 100% lokal; cloud hanya opt-in dengan peringatan jelas.
4. **Ukur sebelum optimasi** — metrik RAM/latensi masuk `/api/stats` sebelum tuning.
5. **Satu identitas proyek = satu realpath** — lintas tool harus menemu-kan memori yang sama.

---

## 2. Fase 0 — Fondasi (P0, 2–3 hari) — ✅ SELESAI 2026-11-03

Semua fase lain bergantung pada ini. Target: tidak ada bug yang membuat fitur
unggulan terlihat bodoh, dan tidak ada celah keamanan.
**Status: 8/8 item dikerjakan di branch `feat/f0-foundation` (lihat `CHANGELOG.md`
bagian Unreleased — smoke test keamanan/pagination/static lolos 10/10).**

| # | Tugas | Lokasi | Status |
|---|-------|--------|--------|
| 0.1 | **Keamanan API**: bind `127.0.0.1`, validasi `Origin`/`Host`, token opsional | `http.ts` | ✅ |
| 0.2 | **Perbaiki `GET /api/memories`**: hormati param `status`, pagination | `http.ts`, `app.js` | ✅ |
| 0.3 | **MCP `recall` embed query** sebelum search; hapus global cache | `mcp/server.ts`, `search.ts` | ✅ |
| 0.4 | **Identitas proyek lintas tool**: satu path kanonik = satu ID | `db.ts`, `ingest/util.ts` | ✅ |
| 0.5 | Fuzzy-match proyek di MCP `project_context`/`remember` | `mcp/server.ts` | ✅ |
| 0.6 | UX aman: konfirmasi delete, `Ctrl/Cmd+Enter` untuk multiline, label scan benar | `app.js`, `index.html` | ✅ |
| 0.7 | Cleanup: hapus `PECUT_SHOT`, toggle auto-start, `lastScan` nyata, port dari config (static serve same-origin) | `main.ts`, `http.ts`, `manager.ts`, `web/*` | ✅ |
| 0.8 | Shortcut configurable + feedback kegagalan registrasi | `main.ts`, `http.ts`, `index.html`, `app.js` | ✅ |

**Definition of Done F0**: semua item di atas terverifikasi di Windows + macOS;
`recall` MCP mengembalikan hasil semantik; tab Memori menampilkan seluruh pustaka
dengan pagination; scan port berbeda tidak memutus UI; akses dari hostname asing ditolak.

---

## 3. Fase 1A — Resume Engine / Limit-Hopping (P0, 5–7 hari) — ✅ SELESAI 100% (2026-11-03)

Fitur inti yang menjawab keresahan asal. Bahan-bahannya sudah ada (watcher, handoff,
tasklife, integrate) — tinggal dirangkai jadi alur "pindah tool tanpa jelasin ulang".
**Status: 3.1–3.5 SELESAI.** Acceptance (3.5) dieksekusi otomatis di macOS dengan
fixture nyata: proyek git asli + transkrip format jsonl Claude Code asli + watcher &
hot-path timer hidup → 12/12 assertion lolos (injeksi otomatis ke AGENTS/CLAUDE/
GEMINI.md, merge lintas-path `/tmp` vs `/private/tmp` jadi SATU proyek, blok
LANJUTAN berisi task/keputusan/branch/file dirty/pesan sesi, resume & remove via
path mentah). Acceptance menangkap & memperbaiki 2 bug tambahan:
`/api/remember` membuang path (merge gagal untuk simpanan dashboard) dan
`GET /api/handoff`/`resume`/`remove` belum fuzzy-resolve. Threshold idle kini
configurable (`resumeIdleMinutes`, default 4).

### 3.1 Hot-path: deteksi akhir sesi → ekstraksi prioritas → inject segera
- Heuristic "session ended": file transkrip suatu sesi tidak bertambah ±3–5 menit
  (`watcher.ts` debounce sudah ada, tambah pelacak per-session last-event).
- Saat terpicu: ekstraksi **sesi itu duluan** (bukan antri batch global), lalu inject
  langsung ke file target proyek tersebut.
- Target latensi: konteks resume siap ≤ 5 menit setelah pesan terakhir.
- Fallback antrian lama tetap jalan untuk sisanya.

### 3.2 Multi-file injection (lintas konvensi tool)
- Tool membaca file berbeda: Codex/opencode → `AGENTS.md`, Claude Code → `CLAUDE.md`,
  Gemini CLI → `GEMINI.md`.
- Strategi aman lintas OS: **inject blok ber-marker yang sama ke semua file target**
  (marker `<!-- memoria:start/end -->` sudah idempotent — `handoff.ts:86-88`).
  ⚠️ Jangan andalkan symlink di Windows (butuh Admin/Developer Mode); duplikasi blok
  ber-marker bekerja identik di kedua OS. Symlink boleh jadi opsi di macOS.
- Mapping tool→file di `integrate.ts`, konfigurabel per proyek (toggle di tab Integrasi).

### 3.3 Section "⏸️ LANJUTAN SESI" di handoff
Blok khusus di paling atas handoff, digabung dari bahan tanpa-LLM (murah & cepat):
- `task_pending` terbaru (sudah ada di `tasklife.ts`)
- **`git status`** — branch + file dirty (BARU; `git.ts` baru punya `git log` —
  ini sinyal "pekerjaan terakhir" paling akurat)
- 2–3 pesan terakhir sesi yang baru selesai
- Timestamp + tool sumber, format persis seperti mock-up di percakapan.

### 3.4 Plan B anti-gagal: "Salin prompt lanjutan"
- Tombol di dashboard + aksi di global palette: salin 3–5 baris resume prompt
  siap-paste ke tool mana pun.
- Menjamin alur tetap jalan walau injeksi file gagal (izin, tool tidak baca file).

### 3.5 Verifikasi lintas tool (uji manual, kedua OS)
Script acceptance: kerja nyata di Claude Code → diamkan 6 menit → buka Codex & opencode
di proyek sama → cek file target berisi blok LANJUTAN dengan task list benar.

**Definition of Done F1A**: skenario limit-hopping lolos di ≥3 pasang tool
(Claude→Codex, Claude→opencode, Codex→Gemini) di Windows DAN macOS; latensi injeksi ≤ 5 menit.

---

## 4. Fase 1B — Tiered Intelligence: Ollama Opsional (P1, 5–7 hari) — ✅ SELESAI 2026-11-04

**Status: dikerjakan di branch `feat/f1b-tiered-providers`, smoke test 6/6
(tanpa Ollama sama sekali): heuristik menghasilkan 3 draft terklasifikasi benar
(decision/error_fixed/task_pending), origin+dialek hash tercatat, search keyword
& semantik-hash jalan, approve→aktif, dedupe hash menggabungkan duplikat.**
Smoke test menangkap & memperbaiki bug privasi: mode auto sempat jatuh ke tier
OpenAI hanya karena URL default — kini auto tidak pernah memilih cloud.
(Wizard first-run & penyimpanan key via safeStorage = sisa item 4.4, masuk F2.)

### 4.1 Interface `MemoryProvider`
```
interface MemoryProvider {
  extract(conversation): Promise<ExtractedMemory[] | null>;
  embed(text): Promise<number[] | null>;
}
```
Tiga implementasi:
- **HeuristicProvider** (Tier 0, default — tanpa model, tanpa network)
- **OllamaProvider** (Tier 1 — kode sekarang, `ollama.ts` dipindah)
- **OpenAICompatProvider** (Tier 2 — satu protokol untuk LM Studio, llama.cpp,
  vLLM, OpenRouter, cloud API; `Base URL + key + model`)

### 4.2 Tier 0 Heuristik (tanpa model apapun)
- Ekstraksi berbasis aturan, memanfaatkan `entities.ts` yang sudah ada:
  `decision` ("pakai/pilih X daripada Y", "decided to"), `task_pending` ("TODO",
  "next step", "belum selesai"), `error_fixed` (stack trace + kalimat solusi),
  `fact` (kalimat padat entity path/versi/config).
- **Sinergi review mode** (`db.ts:158`): hasil heuristik → otomatis masuk tab
  "Menunggu Persetujuan" → user tanpa Ollama mendapat *inbox kurasi*, bukan layar kosong.
- Tandai `origin: "heuristic"` → badge transparansi di dashboard.
- Embedding fallback **hashing TF-IDF ~256 dim, pure JS** (tanpa model) — cukup
  untuk dedupe + edge similarity graph. Kolom baru `embed_model` agar vektor
  dialect berbeda tidak dibandingkan silang (`search.ts:16` wajib cek ini).
- Dedupe fallback berbasis teks (normalisasi + trigram/Jaccard) di
  `dedupe.ts:24-28` — sekarang cabang tanpa-embedding langsung insert tanpa cek.

### 4.3 Tier 2 Cloud (opt-in keras)
- Toggle terpisah per kapabilitas: "izinkan ekstraksi ke cloud" ≠ "izinkan embedding
  ke cloud", dengan warning privasi eksplisit (jangan gobrak janji "100% lokal").
- **API key disimpan via `safeStorage`** → Keychain (macOS) / DPAPI (Windows).
  Mode CLI/MCP murni (di luar Electron): fallback file terenkripsi atau tolak dengan pesan.

### 4.4 UX penyatu
- First-run wizard: deteksi Ollama terpasang? → tawarkan pull model **dengan
  konfirmasi ukuran download** (saat ini `ollama.ts:12-16` auto-pull GB tanpa izin!).
  Tidak ada? → "Mode Heuristik aktif, upgrade kapan saja."
- Chip status engine di Overview: "🧠 Heuristik / Ollama (qwen2.5-coder:3b) / LM Studio".
- Circuit breaker `embed()`: timeout pendek (5–8 dtk), 3x gagal → skip sementara —
  jangan biarkan MCP `remember`/`/api/remember` nge-hang 60 dtk (`ollama.ts:47`).
- `ollama-serve.ts`: cek terinstal sebelum spawn.

**Definition of Done F1B**: fresh install tanpa Ollama di Windows & macOS menghasilkan
memori (draft heuristik) dalam ≤ 10 menit pemakaian; search & handoff berfungsi;
pemakai Ollama tidak merasakan perubahan (regresi nol).

---

## 5. Fase 1C — Retrieval & Skala (P1, 3–4 hari)

| # | Tugas | Lokasi |
|---|-------|--------|
| 5.1 | **FTS5** untuk keyword search (ganti loop JS per-dokumen `search.ts:51-72`) + index `memories(archived,status)`, `transcripts(extracted,ts)` | `store/db.ts` |
| 5.2 | Embedding → **BLOB Float32** (hemat ~50% + hilang jank `JSON.parse` di `vecfind.ts:27`); lazy-build index | `vecfind.ts`, `vecindex.ts` |
| 5.3 | Batch embedding (endpoint `/api/embed` Ollama menerima array) — 1 call per ±20 memori, bukan per memori | `extractor.ts:76` |
| 5.4 | Dedupe: kandidat via SQL (project + recency) bukan `allMemories()` penuh | `dedupe.ts:30` |
| 5.5 | **SSE `/api/events`** — memori baru, draft, progress scan live di dashboard (ganti polling 12 dtk `app.js:1201`) | `http.ts`, `app.js` |
| 5.6 | Metrik self-report: `process.memoryUsage()`, durasi scan, kedalaman antrian → `/api/stats` + kartu di Overview | `manager.ts` |

---

## 6. Fase 2 — Dashboard Design & UX (P2, 5–7 hari)

1. **Loading skeleton + error banner retry** — tab Memori/Overview kini layar kosong
   diam; `renderMemories` (`app.js:223`) bahkan tanpa try/catch.
2. **Proyek drill-down** — baris proyek diklik → detail (memori, timeline, tugas,
   handoff, git). Sekarang read-only stub tanpa handler klik.
3. **Tab Tugas** — endpoint `/api/tasks` (`http.ts:128`) sudah ada tanpa UI;
   tampilan pending/done per proyek. Pembeda unik Memoria.
4. **Graph**: label top-N node, hover tooltip, dirty-flag render (stop saat `alpha`
   ≤ 0.01 — sekarang 60fps permanen `app.js:609-659`), seed posisi stabil,
   strategi kluster > 250 node.
5. **Handoff**: preview diff sebelum inject, pilih file target, tombol "lepas injeksi"
   (endpoint `/api/handoff/remove` sudah ada, UI tidak), backup AGENTS.md sebelum inject pertama.
6. **Theme & a11y**: light theme (`prefers-color-scheme`), keyboard nav + `role`
   untuk sidebar/toggle, hint ⌘ vs Ctrl (`index.html:558`).
7. **Refactor**: modul `web/shared.js` (konstanta `KIND_*`, `esc`, port — kini
   terduplikasi di 3 file JS), event delegation ganti re-bind `bindRowActions`.
8. Font lokal (kini Google Fonts = dependensi online untuk app offline).
9. *(Opsional, jika direncanakan)* ekstraksi string ke `i18n.js` — WAJIB dilakukan
   SEBELUM polish F2 jika target audiens EN; menyusuri ulang 1200 baris `app.js`
   dua kali itu mubazir.

---

## 7. Fase 3 — Ekspansi (P3, fleksibel)

- **Webhook/hook** (Slack/Discord/Telegram) + plugin API — kandidat pertumbuhan #1.
- **Sinkronisasi terenkripsi antar mesin** (age/libsodium; resolusi konflik per memori).
- Palet global: aksi "buka di dashboard", bukan hanya copy (`palette.js:66-71`).
- **Test suite (vitest)**: scoring search, dedupe, marker handoff, parser per tool —
  prasyarat sebelum distribusi luas.
- Distribusi: code signing + notarization (macOS Gatekeeper), mengurangi warning
  SmartScreen (Windows) — atau minimal dokumentasi "klik kanan → Open".

---

## 8. Matriks Windows × macOS (per-item, bukan setelah jadi)

| Aspek | Windows | macOS | Aksi |
|---|---|---|---|
| Path sumber | `%APPDATA%`, `%LOCALAPPDATA%` | `~/Library/Application Support` | Sudah benar di `config.ts:31-40` — **verifikasi live** kedua OS |
| Ollama binary | `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` | `/Applications/Ollama.app/.../ollama` | Sudah ada (`config.ts:59-65`); cek juga `brew` path |
| Multi-file injection | Duplikasi blok ber-marker (symlink butuh Admin/Dev Mode) | Duplikasi blok, symlink opsional | Strategi tunggal: **blok duplikat** — aman di keduanya |
| Penyimpanan API key | DPAPI via `safeStorage` | Keychain via `safeStorage` | Satu API, perilaku beda OS otomatis; fallback jelas di CLI murni |
| Shortcut global | `Ctrl+Shift+Space` bisa bentrok IME | `⌘⇧Space` bisa bentrok Spotlight/input source | **Shortcut configurable** (F0.8), jangan hardcode |
| Tray icon | `.ico` multi-resolusi | **Template image** (hitam-putih, ikut dark/light menu bar) | Tambah varian `logoTemplate.png` |
| Auto-start | Registry/Startup | `setLoginItemSettings({ openAsHidden: true })` | Toggle UI (F0.7), jangan paksa on |
| Watcher FS | `ReadDirectoryChangesW` (native, oke) | FSEvents (native, oke) | chokidar sudah menangani; jangan set `usePolling` |
| Kinerja Ollama | Umumnya CPU-only → ekstraksi lambat | Apple Silicon → Metal GPU, jauh lebih cepat | Ekspektasi UX beda; hot-path F1A penting untuk Windows |
| Installer | NSIS `.exe` (warning SmartScreen jika unsigned) | `.dmg` (Gatekeeper; kanan-klik → Open) | Dokumentasikan di F3; signing menyusul |
| Build CI | Runner Windows | Runner macOS (wajib untuk `.dmg`) | `build.yml` sudah ada — pastikan kedua job hijau tiap fase |
| Ukuran RAM | Baseline sama | macOS kompres memori — ukur `footprint`, bukan hanya RSS | Metrik F1C |

### Checklist verifikasi mac (pertama kali, sebelum F1A)
1. `npm run build && npm run status` → per-tool count tidak nol untuk tool yang dipakai.
2. Tray muncul & tidak "hilang" di menu bar notch.
3. `⌘⇧M` / `⌘⇧Space` tidak bentrok → ubah shortcut bila perlu.
4. Scan proyek mac nyata → cek slug proyek konsisten (prasyarat F0.4).
5. Ollama via Metal: ukur durasi ekstraksi 1 sesi (baseline F1B/F1C).

---

## 9. Estimasi & Urutan Eksekusi

```
Minggu 1      F0 (2–3 hr) + mulai F1A (audit identitas proyek dulu!)
Minggu 2      F1A selesai + acceptance lintas tool di 2 OS
Minggu 3      F1B (provider + heuristik + wizard)
Minggu 4      F1B selesai + F1C (FTS5, BLOB, SSE, metrik)
Minggu 5      F2 (design & UX) — bisa diparalel sebagian dengan F1C
Minggu 6+     F3 sesuai umpan balik user
```

Yang boleh paralel: F2 (pekerjaan web/JS) terpisah dari F1B/F1C (pekerjaan engine).
Yang tidak boleh dilewati: **F0.4 identitas proyek** — kalau bocor, F1A percuma.

## 10. Risiko & Mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Slug proyek lintas tool tak bisa dinormalisasi sempurna | F1A gagal silent | F0.4 paling awal; fallback: manual mapping UI (pilih proyek dari path) |
| Ekstraksi heuristik berisik (false positive) | Inbox draft membingungkan | Default masuk draft + importance rendah; iterasi pola dari data nyata |
| Vektor hashing & nomic tercampur | Search kacau | Kolom `embed_model` + tolak cosine lintas dialect |
| Regresi pemakai Ollama lama saat refactor provider | Kehilangan kepercayaan | Acceptance F1B: regresi nol; test skor search sebelum/sesudah |
| Injeksi ber-marker menabrak file yang diedit user | Konten user rusak | Marker idempotent + backup file sebelum inject pertama (F2.5) |

## 11. Acceptance Script Manual (tiap fase, jalankan di Windows & macOS)

- **F0**: (a) akses `http://<ip-lan>:48210/api/stats` dari device lain → ditolak;
  (b) tab Memori menampilkan > 8 item + pindah halaman; (c) recall MCP untuk pertanyaan
  sinonim (bukan keyword persis) mengembalikan memori.
- **F1A**: limit-hopping nyata Claude→Codex→Gemini; blok LANJUTAN muncul di 3 file;
  task list & branch benar; tombol "Salin prompt lanjutan" menghasilkan teks siap-paste.
- **F1B**: uninstall Ollama → 10 menit pemakaian normal → inbox draft berisi kandidat
  memori; approve → muncul di recall. Install ulang Ollama → otomatis naik tier tanpa kehilangan data.
- **F1C**: 5.000 memori sintetis → search < 100 ms, RAM engine stabil, dashboard
  update live tanpa refresh.
- **F2**: jalankan memori list 500 item — scroll mulus; semua aksi punya loading state
  dan error state; delete selalu konfirmasi.
