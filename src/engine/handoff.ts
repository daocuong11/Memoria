import * as fs from "node:fs";
import * as path from "node:path";
import { allMemories, getDb, projectRecord, getBoolSetting, getSetting, setSetting, readMemories } from "./store/db";
import { runGitLog, isGitRepo, runGitStatus, GitStatus } from "./git";

const KIND_LABEL: Record<string, string> = {
  fact: "Facts / Architecture",
  decision: "Decisions",
  task_done: "Completed tasks",
  task_pending: "Running tasks / Plans",
  error_fixed: "Errors & Fixes",
  preference: "User preferences",
  context: "Context",
};

export interface HandoffOptions {
  slim?: boolean;
  topKinds?: string[];
}

/* ---------- Resume Engine: "SESSION CONTINUATION" block ----------
 * Covers the limit-hopping scenario: the user switches tools mid-task,
 * and the new tool must immediately know what is being worked on.
 * All material is collected WITHOUT an LLM (cheap & fast):
 *   1. Last transcript session (tool + time + closing message)
 *   2. Unfinished task_pending items (task lifetime)
 *   3. Latest decision (a "locked" decision)
 *   4. git status: branch + files currently changing
 * --------------------------------------------------------- */

interface ResumeData {
  lastTool: string | null;
  lastTs: number;
  tasks: Array<{ content: string; importance: number }>;
  decisions: Array<{ content: string; importance: number }>;
  git: GitStatus | null;
  lastMessages: Array<{ role: string; content: string }>;
  snapshot?: string;
}

function normResume(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 90);
}

function pushUnique(
  arr: Array<{ content: string; importance: number }>,
  content: string,
  importance: number,
  limit: number
): void {
  const c = content.replace(/\s+/g, " ").trim();
  if (!c || c.length < 10) return;
  const k = normResume(c);
  if (arr.some((x) => normResume(x.content) === k)) return;
  if (arr.length < limit) arr.push({ content: c.slice(0, 180), importance });
}

function deriveResumeFromTranscripts(projectId: number): { tasks: Array<{ content: string; importance: number }>; decisions: Array<{ content: string; importance: number }> } {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT role, content FROM transcripts WHERE project_id = ? ORDER BY ts DESC, seq DESC LIMIT 40`
    )
    .all(projectId) as Array<{ role: string; content: string }>;
  const tasks: Array<{ content: string; importance: number }> = [];
  const decisions: Array<{ content: string; importance: number }> = [];
  const todoRe = /\b(todo|next step|next steps|follow[- ]?up|remaining|still need|not yet|belum selesai|belum dibuat|akan dibuat|akan ditambahkan|tinggal|lanjut(kan)?|perlu dibuat|perlu diperbaiki|perlu ditambah|harus di|nanti|blocked|wip|plan to|need to|should)\b/i;
  const decRe = /\b(keputusan|disepakati|diputuskan|kita pakai|kita pilih|kami pakai|memakai|menggunakan|pilih|daripada|decided|we('ll| will)? use|going with|chose|chosen|instead of|settle(d)? (on|for)|opt(ed)? for)\b/i;
  for (const r of rows) {
    const text = (r.content || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const candidates: string[] = [];
    const lines = (r.content || "").split("\n");
    for (const line of lines) {
      const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[( |x|X)\]\s*)?(.*)$/);
      if (m) {
        if (m[1] === "x" || m[1] === "X") continue;
        const body = (m[2] || "").trim();
        if (body.length >= 12) candidates.push(body);
      }
    }
    candidates.push(text.slice(0, 220));
    for (const c of candidates) {
      if (decRe.test(c)) pushUnique(decisions, c, 0.55, 3);
      if (todoRe.test(c) || /^\s*(todo|next|plan|fix|add|implement|update|create|remove|refactor|investigate|check|verify|test)\b/i.test(c)) {
        pushUnique(tasks, c, 0.55, 5);
      }
      if (tasks.length >= 5 && decisions.length >= 3) break;
    }
    if (tasks.length >= 5 && decisions.length >= 3) break;
  }
  return { tasks, decisions };
}

export async function collectResumeData(slug: string, opts: { slim?: boolean } = {}): Promise<ResumeData | null> {
  const proj = projectRecord(slug);
  if (!proj) return null;
  const db = getDb();
  const maxTasks = opts.slim ? 3 : 5;
  const maxDecisions = opts.slim ? 2 : 3;
  const maxMsgs = opts.slim ? 1 : 3;

  const lastSession = db
    .prepare(
      `SELECT session_id AS sid, tool, MAX(ts) AS m FROM transcripts
       WHERE project_id = ? GROUP BY session_id ORDER BY m DESC LIMIT 1`
    )
    .get(proj.id) as { sid: string; tool: string; m: number } | undefined;

  const tasks = db
    .prepare(
      `SELECT content, importance FROM memories
       WHERE project_id = ? AND kind = 'task_pending' AND archived = 0 AND status = 'active'
         AND COALESCE(resolved_at, 0) = 0
       ORDER BY created_at DESC LIMIT ${maxTasks}`
    )
    .all(proj.id) as Array<{ content: string; importance: number }>;

  const decisions = db
    .prepare(
      `SELECT content, importance FROM memories
       WHERE project_id = ? AND kind = 'decision' AND archived = 0 AND status = 'active'
         AND COALESCE(superseded_by, 0) = 0
       ORDER BY created_at DESC LIMIT ${maxDecisions}`
    )
    .all(proj.id) as Array<{ content: string; importance: number }>;

  // Deterministic fallback (no LLM): when structured memories are not enough yet,
  // pull signals from heuristic drafts/snapshots & the latest transcripts so
  // limit-hopping still connects in offline/heuristic mode.
  if (tasks.length < maxTasks || decisions.length < maxDecisions) {
    try {
      const drafts = readMemories(
        `WHERE project_id = ? AND archived = 0 AND status = 'draft' AND origin = 'heuristic'
         ORDER BY created_at DESC LIMIT 40`,
        [proj.id]
      );
      for (const m of drafts) {
        if (tasks.length < maxTasks && m.kind === "task_pending") pushUnique(tasks, m.content, m.importance || 0.5, maxTasks);
        if (decisions.length < maxDecisions && m.kind === "decision") pushUnique(decisions, m.content, m.importance || 0.5, maxDecisions);
        if (tasks.length >= maxTasks && decisions.length >= maxDecisions) break;
      }
    } catch { /* ignore */ }
  }
  if (tasks.length < maxTasks || decisions.length < maxDecisions) {
    const derived = deriveResumeFromTranscripts(proj.id);
    for (const t of derived.tasks) pushUnique(tasks, t.content, t.importance, maxTasks);
    for (const d of derived.decisions) pushUnique(decisions, d.content, d.importance, maxDecisions);
  }

  let snapshot: string | undefined;
  try {
    const snap = db
      .prepare(
        `SELECT content FROM memories
         WHERE project_id = ? AND archived = 0 AND status = 'active' AND origin = 'heuristic'
           AND content LIKE 'Work snapshot%'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(proj.id) as { content: string } | undefined;
    if (snap?.content) snapshot = snap.content;
  } catch { /* ignore */ }

  const lastMessages = lastSession
    ? (
        db
          .prepare(
            `SELECT role, content FROM transcripts
             WHERE project_id = ? AND session_id = ?
             ORDER BY ts DESC, seq DESC LIMIT ${maxMsgs}`
          )
          .all(proj.id, lastSession.sid) as Array<{ role: string; content: string }>
      ).reverse()
    : [];

  const git = proj.path && fs.existsSync(proj.path) ? await runGitStatus(proj.path) : null;

  return {
    lastTool: lastSession?.tool ?? null,
    lastTs: lastSession?.m ?? 0,
    tasks,
    decisions,
    git,
    lastMessages,
    snapshot,
  };
}

function hhmm(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 5);
}

function shortText(s: string, max = 140): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max) + (s.length > max ? "…" : "");
}

/** Lines for the "⏸️ SESSION CONTINUATION" section — empty when there is no data at all. */
export function resumeSectionLines(d: ResumeData): string[] {
  const hasAny = d.lastTool || d.tasks.length || d.decisions.length || (d.git?.dirty.length ?? 0) || !!d.snapshot;
  if (!hasAny) return [];
  const lines: string[] = [];
  const head = [
    "## SESSION RESUME",
    `> ${d.lastTool ?? "tool tidak diketahui"}${d.lastTs ? ` · ${hhmm(d.lastTs)}` : ""}${
      d.git?.branch ? ` · branch: ${d.git.branch}` : ""
    }`,
  ];
  lines.push(...head);
  if (d.tasks.length) {
    lines.push("", "**Open tasks:**");
    for (const t of d.tasks) lines.push(`- [ ] ${shortText(t.content, 160)}`);
  }
  if (d.decisions.length) {
    lines.push("", "**Locked decisions (do not repeat):**");
    for (const c of d.decisions) lines.push(`- ${shortText(c.content, 160)}`);
  }
  if (d.git?.dirty.length) {
    const extra = Math.max(0, d.git.dirty.length - 8);
    lines.push("", `**Dirty files (git):** ${d.git.dirty.slice(0, 8).join(", ")}${extra > 0 ? ` (+${extra} lainnya)` : ""}`);
  }
  if (d.snapshot) {
    lines.push("", `**Latest snapshot:** ${shortText(d.snapshot.replace(/^Work snapshot[^:]*:?\s*/i, ""), 200)}`);
  }
  if (d.lastMessages.length) {
    lines.push("", "**Last session messages:**");
    for (const m of d.lastMessages) lines.push(`- (${m.role}) ${shortText(m.content, 180)}`);
  }
  lines.push("", "_Continue the work above — do not re-litigate locked decisions._");
  return lines;
}

/** Short prompt ready to paste into any tool — plan B when file injection is not read. */
export async function generateResumePrompt(slug: string): Promise<string> {
  const d = await collectResumeData(slug, { slim: true });
  if (!d) return `(No project data for "${slug}")`;
  const lines: string[] = [];
  lines.push(
    `Continue the previous work in this project. Context from Memoria (last session: ${
      d.lastTool ?? "?"
    }${d.lastTs ? `, ${hhmm(d.lastTs)}` : ""}):`
  );
  if (d.git?.branch) {
    lines.push(`- Branch: ${d.git.branch}${d.git.dirty.length ? ` — file berubah: ${d.git.dirty.slice(0, 5).join(", ")}` : ""}`);
  }
  if (d.tasks.length) {
    lines.push("- Open tasks:");
    d.tasks.forEach((t, i) => lines.push(`  ${i + 1}) ${shortText(t.content, 130)}`));
  }
  if (d.decisions.length) {
    lines.push(`- Locked decisions: ${d.decisions.map((c) => shortText(c.content, 80)).join("; ")}`);
  }
  if (d.snapshot) {
    lines.push(`- Snapshot: ${shortText(d.snapshot.replace(/^Work snapshot[^:]*:?\s*/i, ""), 140)}`);
  }
  if (d.lastMessages.length) {
    lines.push(`- Last message: (${d.lastMessages[d.lastMessages.length - 1].role}) ${shortText(d.lastMessages[d.lastMessages.length - 1].content, 120)}`);
  }
  lines.push("Continue from there. Do not repeat the decisions above.");
  return lines.join("\n");
}

export async function generateHandoff(slug: string, opts: HandoffOptions = {}): Promise<string> {
  const proj = projectRecord(slug);
  if (!proj) return `# Handoff — ${slug}\n\n(No project data)`;

  const lines: string[] = [];
  lines.push(`# Project handoff: ${proj.name || slug}`);
  lines.push(`> Generated by Memoria — ${new Date().toISOString().slice(0, 16)}`);

  // Resume block at the VERY TOP: the first part an agent reads when a new session opens.
  try {
    const resume = await collectResumeData(slug, { slim: !!opts.slim });
    const resumeLines = resume ? resumeSectionLines(resume) : [];
    if (resumeLines.length) lines.push("", ...resumeLines);
  } catch {
    // resume section is best-effort — never block the main handoff
  }

  const memories = allMemories().filter((m) => m.projectId === proj.id);
  lines.push("", `## Memories (${memories.length})`);
  if (!memories.length) {
    lines.push("No memories for this project yet.");
  } else {
    const order: string[] = opts.topKinds || ["task_pending", "decision", "error_fixed", "fact", "preference", "context", "task_done"];
    const buckets = new Map<string, typeof memories>();
    for (const m of memories) {
      if (!buckets.has(m.kind)) buckets.set(m.kind, []);
      buckets.get(m.kind)!.push(m);
    }
    let total = 0;
    const maxTotal = opts.slim ? 12 : 50;
    for (const kind of order) {
      if (total >= maxTotal) break;
      const items = buckets.get(kind);
      if (!items?.length) continue;
      lines.push("", `### ${KIND_LABEL[kind] || kind}`);
      const sorted = items.sort((a, b) => b.importance - a.importance);
      const take = opts.slim ? Math.max(1, Math.ceil((maxTotal - total) / (order.length - order.indexOf(kind)))) : sorted.length;
      for (const it of sorted.slice(0, take)) {
        lines.push(`- [${(it.importance * 100).toFixed(0)}] ${it.content}`);
        total++;
        if (total >= maxTotal) break;
      }
    }
  }

  if (!opts.slim && proj.path && fs.existsSync(proj.path)) {
    if (await isGitRepo(proj.path)) {
      const gitLog = await runGitLog(proj.path, 15);
      if (gitLog.length) {
        lines.push("", "## Aktivitas Git Terbaru");
        for (const g of gitLog) lines.push(`- ${g.date} ${g.message}`);
      }
    }
  }

  if (!opts.slim) {
    const db = getDb();
    const lastT = db
      .prepare(
        `SELECT role, content, ts FROM transcripts WHERE project_id = ? ORDER BY ts DESC LIMIT 5`
      )
      .all(proj.id) as Array<{ role: string; content: string; ts: number }>;
    if (lastT.length) {
      lines.push("", "## Recent activity", "");
      for (const t of lastT.reverse()) {
        const text = t.content.replace(/\s+/g, " ").slice(0, 180);
        lines.push(`- (${t.role}) ${text}`);
      }
    }
  }

  return lines.join("\n");
}

/* ---------- Multi-file injection ----------
 * Each tool reads a different context file: Codex/opencode -> AGENTS.md,
 * Claude Code -> CLAUDE.md, Gemini CLI -> GEMINI.md. The same
 * marker-delimited block is injected into each target file. Block duplication
 * (not symlinks) is chosen to stay safe on Windows without special privileges.
 * Each target can be disabled via the `injectFile:<file-name>` setting.
 * ------------------------------------------- */

export const INJECTION_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;

export function injectionTargets(): string[] {
  return INJECTION_FILES.filter((f) => getBoolSetting(`injectFile:${f}`, true));
}

export async function injectHandoffAll(slug: string, opts: HandoffOptions = {}): Promise<Array<{ file: string; ok: boolean }>> {
  const results: Array<{ file: string; ok: boolean }> = [];
  for (const file of injectionTargets()) {
    const r = await injectHandoff(slug, file, opts);
    results.push({ file: r.file, ok: r.ok });
  }
  return results;
}

export function removeInjectAll(slug: string): Array<{ file: string; ok: boolean }> {
  return injectionTargets().map((file) => {
    const r = removeInject(slug, file);
    return { file: r.file, ok: r.ok };
  });
}

const MARK_START = "<!-- memoria:start -->";
const MARK_END = "<!-- memoria:end -->";
const MARK_RE = /<!-- (?:pecut-memory|memoria):start -->[\s\S]*?<!-- (?:pecut-memory|memoria):end -->\n?/;

export async function injectHandoff(slug: string, targetFile = "AGENTS.md", opts: HandoffOptions = {}): Promise<{ ok: boolean; file: string }> {
  const proj = projectRecord(slug);
  if (!proj || !proj.path) return { ok: false, file: targetFile };
  const md = await generateHandoff(slug, opts);
  const block = `${MARK_START}\n${md}\n${MARK_END}\n`;
  const target = path.join(proj.path, targetFile);
  try {
    let existing = "";
    if (fs.existsSync(target)) existing = fs.readFileSync(target, "utf8");
    // Local metric: this resume block is read by the agent at the start of the next session.
    try {
      const { recordContextServed } = require("./retrieve/usage") as typeof import("./retrieve/usage");
      if (targetFile === injectionTargets()[0]) recordContextServed("resume", proj.id, block.length);
    } catch {
      /* non-critical metric */
    }
    if (existing.includes(MARK_START) && existing.includes(MARK_END)) {
      existing = existing.replace(MARK_RE, block);
    } else if (existing.includes("<!-- pecut-memory:start -->")) {
      existing = existing.replace(MARK_RE, block);
    } else {
      // New file: do not add a blank line at the start.
      existing = existing.trimEnd() ? existing.trimEnd() + "\n\n" + block : block;
    }
    fs.writeFileSync(target, existing, "utf8");
    return { ok: true, file: targetFile };
  } catch {
    return { ok: false, file: targetFile };
  }
}

export async function autoInjectContext(): Promise<string[]> {
  if (!getBoolSetting("autoInjectProjectFiles", true)) return [];
  const injected: string[] = [];
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT slug, id FROM projects
       WHERE last_seen >= ? AND path IS NOT NULL AND path != ''
       ORDER BY last_seen DESC LIMIT 10`
    )
    .all(Date.now() - 7 * 86400000) as Array<{ slug: string; id: number }>;
  for (const p of rows) {
    try {
      const lastTs = db
        .prepare("SELECT MAX(ts) AS m FROM transcripts WHERE project_id = ?")
        .get(p.id) as { m: number };
      const lastInject = Number(getSetting(`proj:${p.slug}:handoff_at`, "0"));
      if (lastTs.m > lastInject) {
        const rs = await injectHandoffAll(p.slug, { slim: true });
        if (rs.some((r) => r.ok)) {
          setSetting(`proj:${p.slug}:handoff_at`, String(Date.now()));
          injected.push(p.slug);
        }
      }
    } catch {
      continue;
    }
  }
  return injected;
}

export function removeInject(slug: string, targetFile = "AGENTS.md"): { ok: boolean; file: string } {
  const proj = projectRecord(slug);
  if (!proj || !proj.path) return { ok: false, file: targetFile };
  const target = path.join(proj.path, targetFile);
  try {
    if (!fs.existsSync(target)) return { ok: false, file: targetFile };
    const content = fs.readFileSync(target, "utf8");
    const next = content.replace(MARK_RE, "");
    fs.writeFileSync(target, next, "utf8");
    return { ok: true, file: targetFile };
  } catch {
    return { ok: false, file: targetFile };
  }
}