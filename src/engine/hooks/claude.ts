/* ---------- Claude Code native hooks ----------
 * Complements the file watcher with events Claude Code reports itself
 * (https://code.claude.com/docs/en/hooks):
 *   SessionStart (sync)  print the project's resume context; Claude Code adds
 *                        plain-text stdout to the session as context
 *   Stop        (async)  import this session's transcript right away
 *   PreCompact  (async)  import + deterministic work snapshot before the
 *                        context is compacted (the most "pre-limit" moment)
 *   SessionEnd  (async)  import + extract + refresh AGENTS.md/CLAUDE.md
 * Hooks must never break Claude Code: everything is best effort, output goes
 * to stdout only for SessionStart, and the process always exits 0.
 * ------------------------------------------------------------------------- */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const HOOK_EVENTS = ["SessionStart", "Stop", "PreCompact", "SessionEnd"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

const MAX_CONTEXT_CHARS = 4000;

async function readStdin(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return "";
  return new Promise((resolve) => {
    let data = "";
    const done = () => resolve(data);
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** `body` without the lines already present in `file`; "" when only
 * headings would remain. Missing or unreadable file: `body` unchanged. */
function withoutLinesIn(body: string, file: string): string {
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    return body;
  }
  const seen = new Set(existing.split("\n").map((l) => l.trim()).filter((l) => l.length > 8));
  if (!seen.size) return body;
  const kept = body.split("\n").filter((l) => !seen.has(l.trim()));
  const content = kept.filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim()) && !/^[-*]\s*$/.test(l.trim()));
  if (!content.length) return "";
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** Resume text for the project in `cwd`, or "" when Memoria knows nothing. */
export async function sessionStartContext(cwd: string): Promise<string> {
  const db = require("../store/db") as typeof import("../store/db");
  const proj = cwd ? db.resolveProject(cwd) : null;
  if (!proj) return "";
  const { collectResumeData, resumeSectionLines } = require("../handoff") as typeof import("../handoff");
  const data = await collectResumeData(proj.slug, { slim: true });
  let body = data ? resumeSectionLines(data).join("\n").trim() : "";
  if (!body) {
    const { buildContextBlock } = require("../retrieve/contextblock") as typeof import("../retrieve/contextblock");
    const block = buildContextBlock({ project: proj.slug, maxChars: MAX_CONTEXT_CHARS });
    body = block.startsWith("No project found") ? "" : block;
  }
  if (!body) return "";
  // Claude Code already loads CLAUDE.md, where Memoria writes the same resume
  // block. Send only the lines it does not contain, or just a pointer when
  // nothing is new (scripts/audit-context.mjs measures the duplicate).
  body = withoutLinesIn(body, path.join(cwd, "CLAUDE.md"));
  const tools = "Use the memoria MCP tools (project_context, recall, get_memory, file_context) for more.";
  if (!body) return `Memoria: the resume block for this project is in CLAUDE.md. ${tools}`;
  const text =
    "Memoria: context from earlier sessions on this project (across all AI tools). " +
    tools + "\n\n" +
    body;
  return text.length > MAX_CONTEXT_CHARS ? text.slice(0, MAX_CONTEXT_CHARS - 1) + "…" : text;
}

function claudeProjectsRoot(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Only import transcripts that live under ~/.claude/projects. */
function safeTranscript(p: string | undefined): string | null {
  if (!p || p.includes("\0")) return null;
  const resolved = path.resolve(p);
  const root = path.resolve(claudeProjectsRoot());
  if (!resolved.startsWith(root + path.sep) || !resolved.endsWith(".jsonl")) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

export async function runHook(event: string, input: HookInput): Promise<string> {
  const db = require("../store/db") as typeof import("../store/db");
  if (!db.getBoolSetting("claudeHooks", true)) return "";
  if (event === "SessionStart") {
    const text = await sessionStartContext(String(input.cwd || ""));
    if (text) {
      try {
        const { recordContextServed } = require("../retrieve/usage") as typeof import("../retrieve/usage");
        recordContextServed("hook", db.resolveProject(String(input.cwd || ""))?.id ?? null, text.length);
      } catch {
        /* metric only */
      }
    }
    return text;
  }
  const file = safeTranscript(input.transcript_path);
  if (!file) return "";
  const { scanClaude } = require("../ingest/claude") as typeof import("../ingest/claude");
  await scanClaude(file);
  const proj = input.cwd ? db.resolveProject(String(input.cwd)) : null;
  if (event === "PreCompact" && proj) {
    const { captureSessionSnapshot } = require("../extract/snapshot") as typeof import("../extract/snapshot");
    await captureSessionSnapshot(proj.id, "claude");
    db.recordContinuity("limit_hit", proj.id, "claude PreCompact");
  }
  if (event === "PreCompact" || event === "SessionEnd") {
    const { extractQueue } = require("../extract/extractor") as typeof import("../extract/extractor");
    await extractQueue(true, { order: "desc" });
    if (proj) {
      const { injectHandoffAll } = require("../handoff") as typeof import("../handoff");
      if (db.getBoolSetting("autoInjectProjectFiles", true)) {
        const rs = await injectHandoffAll(proj.slug, { slim: true });
        if (rs.some((r) => r.ok)) {
          db.setSetting(`proj:${proj.slug}:handoff_at`, String(Date.now()));
          db.recordContinuity("resume_ready", proj.id, `claude ${event}`);
        }
      }
    }
  }
  return "";
}

/** CLI entry: `memoria hook <Event>`. Reads the hook JSON from stdin. */
export async function hookMain(event: string): Promise<void> {
  // Engine modules log to stdout; for SessionStart stdout IS the context.
  const log = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  let out = "";
  try {
    const raw = await readStdin();
    let input: HookInput = {};
    try {
      input = raw ? JSON.parse(raw) : {};
    } catch {
      input = {};
    }
    const { getConfig } = require("../config") as typeof import("../config");
    const db = require("../store/db") as typeof import("../store/db");
    db.initDb(process.env.MEMORIA_DATA_DIR || getConfig().dataDir);
    out = await runHook(event, input);
  } catch (err) {
    console.error("[memoria] hook:", err instanceof Error ? err.message : err);
  } finally {
    console.log = log;
  }
  if (out) process.stdout.write(out + "\n");
}

/* ---------- install / remove in ~/.claude/settings.json ---------- */

const MARK = " hook ";
const isOurs = (h: any): boolean =>
  typeof h?.command === "string" &&
  /index\.js['"]? hook (SessionStart|Stop|PreCompact|SessionEnd)\b/.test(h.command) &&
  /dist[\\/]engine[\\/]index\.js/.test(h.command);

function settingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function readSettings(file: string): Record<string, any> | null {
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null; // never overwrite a settings file we cannot parse
  }
}

function q(s: string): string {
  return process.platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shell command for one event. Electron's own binary needs
 * ELECTRON_RUN_AS_NODE=1 to behave like node. */
export function hookCommand(nodeCmd: string, script: string, event: HookEvent): string {
  const base = `${nodeCmd === "node" ? "node" : q(nodeCmd)} ${q(script)}${MARK}${event}`;
  if (nodeCmd === "node") return base;
  return process.platform === "win32" ? `set ELECTRON_RUN_AS_NODE=1&& ${base}` : `ELECTRON_RUN_AS_NODE=1 ${base}`;
}

export function removeClaudeHooks(file = settingsPath()): { ok: boolean; removed: number; message: string } {
  const cfg = readSettings(file);
  if (!cfg) return { ok: false, removed: 0, message: `cannot parse ${file}` };
  let removed = 0;
  const hooks = cfg.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]
      .map((group: any) => {
        if (!Array.isArray(group?.hooks)) return group;
        const before = group.hooks.length;
        group.hooks = group.hooks.filter((h: any) => !isOurs(h));
        removed += before - group.hooks.length;
        return group;
      })
      .filter((group: any) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (cfg.hooks && !Object.keys(cfg.hooks).length) delete cfg.hooks;
  if (removed) fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { ok: true, removed, message: removed ? `removed ${removed} Memoria hooks` : "no Memoria hooks installed" };
}

export function installClaudeHooks(nodeCmd: string, script: string, file = settingsPath()): { ok: boolean; message: string } {
  const cfg = readSettings(file);
  if (!cfg) return { ok: false, message: `cannot parse ${file}; not modified` };
  // Idempotent: drop our previous entries (old script paths), keep everyone else's.
  removeClaudeHooks(file);
  const fresh = readSettings(file) || {};
  fresh.hooks = fresh.hooks || {};
  const spec: Record<HookEvent, Record<string, unknown>> = {
    SessionStart: { timeout: 10 },
    Stop: { async: true },
    PreCompact: { async: true },
    SessionEnd: { async: true },
  };
  for (const ev of HOOK_EVENTS) {
    fresh.hooks[ev] = Array.isArray(fresh.hooks[ev]) ? fresh.hooks[ev] : [];
    fresh.hooks[ev].push({ hooks: [{ type: "command", command: hookCommand(nodeCmd, script, ev), ...spec[ev] }] });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + "\n", "utf8");
  return { ok: true, message: `installed ${HOOK_EVENTS.length} hooks in ${file}` };
}

export function claudeHooksInstalled(file = settingsPath()): boolean {
  const cfg = readSettings(file);
  if (!cfg?.hooks) return false;
  return HOOK_EVENTS.every((ev) => (cfg.hooks[ev] || []).some((g: any) => (g?.hooks || []).some(isOurs)));
}
