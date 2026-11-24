import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "../config";
import { ollamaAvailable } from "./ollama";

let spawnedOnce = false;

/** Resolve a bare command name against PATH; returns null when not installed. */
export function findOnPath(cmd: string, envPath = process.env.PATH || ""): string | null {
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Spawn `bin serve` detached. Never throws; spawn errors (ENOENT, EACCES) are swallowed. */
export function spawnServe(bin: string): boolean {
  try {
    const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {
      /* Ollama missing or not executable: stay offline, never crash the app. */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export async function ensureOllamaRunning(): Promise<boolean> {
  if (await ollamaAvailable()) return true;
  if (spawnedOnce) return false;
  spawnedOnce = true;
  const cfg = getConfig();
  const candidates = [cfg.ollamaPath, process.env.OLLAMA_PATH || "", "ollama"];
  for (const cand of candidates) {
    if (!cand) continue;
    const bin = fs.existsSync(cand) ? cand : cand === "ollama" ? findOnPath("ollama") : null;
    if (!bin || !spawnServe(bin)) continue;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await ollamaAvailable()) return true;
    }
  }
  return false;
}
