/* `memoria doctor`: one command that says whether this install is healthy,
 * and what to do when it is not. Read-only: it never repairs anything. */
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "./config";
import { getDb, getSetting, LATEST_SCHEMA } from "./store/db";

export type CheckLevel = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  fix?: string;
}

const DAY = 86_400_000;

function mode(p: string): number | null {
  try {
    return fs.statSync(p).mode & 0o777;
  } catch {
    return null;
  }
}

function dirSize(dir: string): number {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      n += e.isDirectory() ? dirSize(p) : e.isFile() ? fs.statSync(p).size : 0;
    }
  } catch {
    /* missing */
  }
  return n;
}

const mb = (b: number): string => `${(b / 1048576).toFixed(1)} MB`;

export async function runDoctor(opts: { network?: boolean } = {}): Promise<Check[]> {
  const cfg = getConfig();
  const out: Check[] = [];
  const d = getDb();
  const dbPath = path.join(cfg.dataDir, "memory.db");

  // Files and permissions
  if (process.platform !== "win32") {
    const dm = mode(cfg.dataDir);
    const fm = mode(dbPath);
    const loose = (dm != null && (dm & 0o077) !== 0) || (fm != null && (fm & 0o077) !== 0);
    out.push({
      name: "Data folder permissions",
      level: loose ? "fail" : "ok",
      detail: `${cfg.dataDir} ${dm?.toString(8) ?? "?"}, memory.db ${fm?.toString(8) ?? "?"}`,
      fix: loose ? `chmod 700 "${cfg.dataDir}" && chmod 600 "${dbPath}"` : undefined,
    });
  }

  // Database
  const integrity = (d.prepare("PRAGMA quick_check").get() as Record<string, string>)?.quick_check ?? "unknown";
  out.push({
    name: "Database integrity",
    level: integrity === "ok" ? "ok" : "fail",
    detail: integrity === "ok" ? "quick_check ok" : integrity.slice(0, 200),
    fix: integrity === "ok" ? undefined : "Restore the newest file from the backups folder (Settings → Backups).",
  });
  const uv = Number((d.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  out.push({
    name: "Schema version",
    level: uv === LATEST_SCHEMA ? "ok" : uv > LATEST_SCHEMA ? "warn" : "fail",
    detail: `v${uv} (this build: v${LATEST_SCHEMA})`,
    fix: uv > LATEST_SCHEMA ? "The database was opened by a newer Memoria. Update this install." : uv < LATEST_SCHEMA ? "Restart Memoria so the migrations run." : undefined,
  });
  const journal = (d.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
  out.push({ name: "Journal mode", level: journal === "wal" ? "ok" : "warn", detail: journal });
  const size = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  out.push({ name: "Disk use", level: "ok", detail: `database ${mb(size)}, backups ${mb(dirSize(path.join(cfg.dataDir, "backups")))}, transcript archive ${mb(dirSize(path.join(cfg.dataDir, "archive")))}` });

  // Backups
  const backups = (() => {
    try {
      return fs.readdirSync(path.join(cfg.dataDir, "backups")).filter((f) => f.endsWith(".db")).map((f) => fs.statSync(path.join(cfg.dataDir, "backups", f)).mtimeMs);
    } catch {
      return [] as number[];
    }
  })();
  const newest = backups.length ? Math.max(...backups) : 0;
  out.push({
    name: "Backups",
    level: !newest ? "warn" : Date.now() - newest > 7 * DAY ? "warn" : "ok",
    detail: newest ? `${backups.length} file(s), newest ${Math.round((Date.now() - newest) / DAY)} day(s) old` : "none yet",
    fix: !newest || Date.now() - newest > 7 * DAY ? "memoria backup" : undefined,
  });

  // Capture
  try {
    const { captureHealth } = await import("./ingest/health");
    const h = captureHealth();
    const bad = h.filter((x) => x.status === "behind" || x.status === "error");
    out.push({
      name: "Capture",
      level: bad.length ? "warn" : "ok",
      detail: bad.length ? bad.map((x) => `${x.label}: ${x.status} (${x.reason})`).join("; ") : `${h.filter((x) => x.status === "ok").length} tool(s) ok`,
      fix: bad.length ? "Start the Memoria app (or `memoria scan`); see Settings → Capture health." : undefined,
    });
  } catch (e) {
    out.push({ name: "Capture", level: "warn", detail: String(e).slice(0, 200) });
  }
  const pending = (d.prepare("SELECT COUNT(*) AS c FROM transcripts WHERE extracted = 0").get() as { c: number }).c;
  out.push({
    name: "Extraction backlog",
    level: pending > 5000 ? "warn" : "ok",
    detail: `${pending} transcript row(s) waiting; engine ${getSetting("extractEngine", "auto")}`,
    fix: pending > 5000 ? "memoria extract (repeat until the backlog is empty)" : undefined,
  });

  // Models (network: local Ollama only)
  if (opts.network !== false) {
    try {
      const res = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const models = ((await res.json()) as { models?: unknown[] }).models?.length ?? 0;
      out.push({
        name: "Ollama",
        level: models ? "ok" : "warn",
        detail: models ? `${models} model(s) at ${cfg.ollamaUrl}` : `running at ${cfg.ollamaUrl} but no models pulled`,
        fix: models ? undefined : "Optional: `ollama pull <model>` for LLM extraction or semantic embeddings; Tier 0 works without it.",
      });
    } catch {
      out.push({ name: "Ollama", level: "ok", detail: "not running (optional; Tier 0 heuristics are used)" });
    }
  }

  // Integrations
  try {
    const { integrationStatus } = await import("./integrate");
    const s = integrationStatus();
    const on = s.filter((x) => x.configured).map((x) => x.display);
    out.push({
      name: "MCP integrations",
      level: on.length ? "ok" : "warn",
      detail: on.length ? on.join(", ") : "no AI tool has Memoria registered",
      fix: on.length ? undefined : "memoria integrate <claude|codex|opencode|gemini>",
    });
  } catch {
    /* optional */
  }

  // Security
  out.push({
    name: "Local API token",
    level: getSetting("apiTokenRequired", "1") === "0" ? "warn" : "ok",
    detail: getSetting("apiTokenRequired", "1") === "0" ? "turned off: any local process can read your memories" : "required",
    fix: getSetting("apiTokenRequired", "1") === "0" ? "Turn it back on in Settings → Security." : undefined,
  });

  // Sync
  try {
    const { syncStatus } = await import("./sync/keys");
    const st = syncStatus();
    out.push({
      name: "Sync",
      level: st.configured && st.conflicts > 0 ? "warn" : "ok",
      detail: st.configured ? `on (${st.pendingOutbox} pending, ${st.conflicts} conflict(s))` : "off",
      fix: st.configured && st.conflicts > 0 ? "memoria sync conflicts" : undefined,
    });
  } catch {
    /* sync not set up */
  }
  return out;
}

export function formatDoctor(checks: Check[]): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const lines = checks.map((c) => `${mark[c.level]} ${c.name.padEnd(22)} ${c.detail}${c.fix ? `\n    → ${c.fix}` : ""}`);
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  lines.push("", fails ? `${fails} problem(s), ${warns} warning(s).` : warns ? `Healthy, ${warns} warning(s).` : "Healthy.");
  return lines.join("\n");
}
