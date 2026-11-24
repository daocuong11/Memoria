/* Heuristic/no-AI mode: sinyal kuat -> aktif (resume lintas-AI instan),
 * fallback deterministik handoff, dedupe draft heuristik, snapshot aktif. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);

process.env.MEMORIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "memoria-heur-"));
const dbmod = require("../dist/engine/store/db.js");
const { heuristicExtract, assessHeuristicSignal } = require("../dist/engine/extract/heuristic.js");
const { extractQueue } = require("../dist/engine/extract/extractor.js");
const { addMemoryWithDedupe } = require("../dist/engine/extract/dedupe.js");
const { captureSessionSnapshot } = require("../dist/engine/extract/snapshot.js");
const { collectResumeData, resumeSectionLines } = require("../dist/engine/handoff.js");
const { runTaskLifecycle } = require("../dist/engine/extract/tasklife.js");

dbmod.initDb(process.env.MEMORIA_DATA_DIR);
// Paksa mode heuristik/hash (offline, tanpa model/cloud)
dbmod.setSetting("extractEngine", "heuristic");
dbmod.setSetting("embedEngine", "hash");

const pid = dbmod.ensureProject("users-mac-heurproj", "/tmp/heurproj");

function tx(sessionId, role, content, seq, ts = Date.now()) {
  dbmod.insertTranscript({ tool: "claude", sessionId, projectId: pid, role, content, ts, seq });
}

test("heuristicExtract: tangkap todo/keputusan/error-fix + sinyal path/cmd", () => {
  const mems = heuristicExtract([
    { role: "user", content: "TODO: fix login bug in src/auth/login.ts" },
    { role: "assistant", content: "Keputusan: kita pakai JWT daripada session cookie." },
    { role: "user", content: "oke lanjut" },
    { role: "assistant", content: "Error ENOENT saat run `npm run build`, fixed dengan membuat folder dist/." },
    { role: "user", content: "- [ ] tambah tes untuk parser\n- [x] update README" },
  ]);
  const kinds = new Set(mems.map((m) => m.kind));
  assert.ok(kinds.has("task_pending"), "harus ada task pending/todo");
  assert.ok(kinds.has("decision"), "harus ada keputusan");
  assert.ok(kinds.has("error_fixed") || kinds.has("task_done"), "harus ada sinyal fix/done");
  const strong = mems.filter((m) => assessHeuristicSignal(m).activate);
  assert.ok(strong.length >= 2, "sinyal kuat (todo/keputusan/fix/path) harus terdeteksi untuk aktivasi");
});

test("extractQueue heuristik: sinyal kuat -> active, lemah -> draft (origin heuristic)", async () => {
  tx("s1", "user", "TODO: refactor src/engine/http.ts to add /api/health endpoint", 1);
  tx("s1", "assistant", "Keputusan: kita pakai node:http daripada express.", 2);
  tx("s1", "assistant", "Sepertinya prefer gaya kode yang ringkas.", 3); // sinyal lebih lemah
  const n = await extractQueue(true);
  assert.ok(n >= 2, "harus mengekstrak memori");
  const all = dbmod.readMemories("WHERE project_id = ? ORDER BY id ASC", [pid]);
  const heur = all.filter((m) => m.origin === "heuristic");
  assert.ok(heur.length >= 2, "hasil heuristik harus tersimpan");
  assert.ok(heur.some((m) => m.status === "active"), "sinyal kuat harus dipromosikan ke active");
  assert.ok(heur.every((m) => m.origin === "heuristic"), "origin harus heuristic (transparan)");
  // recall/aktif hanya yang active
  const active = dbmod.allMemories().filter((m) => m.projectId === pid);
  assert.ok(active.some((m) => m.kind === "task_pending" || m.kind === "decision"), "task/keputusan kuat harus aktif untuk resume");
});

test("snapshot deterministik: aktif + origin heuristic (kontinuitas limit-hopping)", async () => {
  dbmod.insertTranscript({ tool: "claude", sessionId: "s-snap", projectId: pid, role: "user", content: "Working on src/engine/http.ts, need to add /api/health endpoint", ts: Date.now(), seq: 10 });
  const r = await captureSessionSnapshot(pid, "s-snap", "claude", process.cwd());
  assert.ok(r && r.inserted, "snapshot harus tersimpan");
  const row = dbmod.readMemories("WHERE project_id = ? AND content LIKE 'Work snapshot%'", [pid]).slice(-1)[0];
  assert.ok(row, "snapshot row harus ada");
  assert.equal(row.status, "active");
  assert.equal(row.origin, "heuristic");
  assert.ok((row.content || "").includes("Work snapshot"), "konten snapshot");
});

test("dedupe: draft heuristik bisa di-link/merge oleh pipeline (tidak muncul di recall)", () => {
  const pid2 = dbmod.ensureProject("users-mac-heurproj2", undefined);
  const base = { projectId: pid2, kind: "decision", importance: 0.5, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "draft", origin: "heuristic" };
  const r1 = addMemoryWithDedupe({ ...base, content: "Keputusan: pakai pnpm untuk monorepo build pipeline" });
  assert.ok(r1.inserted);
  const r2 = addMemoryWithDedupe({ ...base, content: "Keputusan: pakai pnpm untuk monorepo build pipeline CI" });
  assert.equal(r2.inserted, false, "duplikat draft heuristik harus merge, bukan insert baru");
  const active = dbmod.allMemories().filter((m) => m.projectId === pid2);
  assert.equal(active.length, 0, "draft tidak boleh muncul di recall aktif");
  const all = dbmod.readMemories("WHERE project_id = ?", [pid2]);
  assert.equal(all.length, 1, "draft heuristik ter-dedupe");
});

test("handoff/resume: fallback deterministik dari transkrip saat memori terstruktur kosong", async () => {
  // Draft/transcript fallback only runs under the evidence promotion policy.
  dbmod.setSetting("tier0Promote", "evidence");
  const pid3 = dbmod.ensureProject("users-mac-heurproj3", "/tmp/heurproj3");
  // hanya transkrip, tanpa memori aktif/draft terstruktur
  dbmod.insertTranscript({ tool: "cursor", sessionId: "s3", projectId: pid3, role: "user", content: "TODO: implement rate limit on /api/login and add tests", ts: Date.now() - 1000, seq: 1 });
  dbmod.insertTranscript({ tool: "cursor", sessionId: "s3", projectId: pid3, role: "assistant", content: "Keputusan: kita pakai token bucket daripada fixed window.", ts: Date.now(), seq: 2 });
  const data = await collectResumeData("users-mac-heurproj3");
  assert.ok(data, "resume data harus ada");
  assert.ok(data.tasks.length >= 1 || data.decisions.length >= 1, "harus menurunkan task/keputusan dari transkrip");
  const lines = resumeSectionLines(data);
  assert.ok(lines.join("\n").includes("SESSION RESUME"));
  assert.ok(lines.join("\n").includes("Open tasks") || lines.join("\n").includes("Locked decisions"));
  dbmod.setSetting("tier0Promote", "structured");
});

test("task lifecycle: task_pending heuristik ditutup saat ada sinyal selesai", () => {
  const pid4 = dbmod.ensureProject("users-mac-heurproj4", undefined);
  const t0 = Date.now() - 5000;
  dbmod.insertTranscript({ tool: "claude", sessionId: "s4", projectId: pid4, role: "user", content: "TODO: fix parser timeout on large files", ts: t0, seq: 1 });
  dbmod.insertTranscript({ tool: "claude", sessionId: "s4", projectId: pid4, role: "assistant", content: "I fixed parser timeout on large files, done.", ts: Date.now(), seq: 2 });
  const r = addMemoryWithDedupe({ projectId: pid4, kind: "task_pending", content: "Fix parser timeout on large files", importance: 0.6, createdAt: t0, lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "draft", origin: "heuristic" });
  assert.ok(r.inserted);
  const inserted = dbmod.readMemories("WHERE project_id = ? AND content LIKE '%parser timeout%'", [pid4])[0];
  assert.ok(inserted && inserted.id, "task heuristik harus tersimpan");
  runTaskLifecycle(pid4);
  const m = dbmod.memoryById(inserted.id);
  assert.ok(m && (m.kind === "task_done" || (m.resolvedAt && m.resolvedAt > 0)), "task heuristik harus ditandai selesai");
});

test("heuristicExtract (Q3): mid-turn narration skipped, one working report per turn, user chatter ignored", () => {
  const mems = heuristicExtract([
    { role: "user", content: "tolong cek kenapa build gagal ya, nanti kabarin" },
    { role: "assistant", content: "Sekarang saya cek dulu log build-nya, nanti saya pakai npm run build untuk reproduksi." },
    { role: "tool", content: "error TS2304: Cannot find name 'foo'." },
    { role: "assistant", content: "Build gagal karena `foo` belum diimpor di src/a.ts. Keputusan: kita pakai named export daripada default export supaya impor konsisten. Sudah diperbaiki dan build lulus lagi." },
    { role: "user", content: "jangan pakai default export lagi di repo ini" },
  ]);
  assert.ok(!mems.some((m) => m.content.startsWith("Sekarang saya cek")), "mid-turn narration is not a source");
  assert.ok(!mems.some((m) => m.content.includes("kenapa build gagal")), "a plain request is not a memory");
  const reports = mems.filter((m) => m.memoryClass === "working");
  assert.equal(reports.length, 1);
  assert.match(reports[0].content, /^Build gagal karena/);
  assert.ok(mems.some((m) => m.kind === "decision" && /named export/.test(m.content)));
  assert.ok(mems.some((m) => m.kind === "preference" && /default export/.test(m.content)), "a stated rule from the user is kept");
});

test("turnReport: code and tables dropped, markdown stripped, cut at a sentence", async () => {
  const { turnReport } = await import("../dist/engine/extract/heuristic.js");
  const r = turnReport("## Done\n**Fixed** the build.\n```ts\nconst x = 1;\n```\n| a | b |\n|---|---|\nNext: " + "word ".repeat(200) + ". Tail.");
  assert.ok(r.startsWith("Done Fixed the build. Next:"));
  assert.ok(!r.includes("const x") && !r.includes("| a |"));
  assert.ok(r.length <= 601);
});
