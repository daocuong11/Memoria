#!/usr/bin/env node
import { getConfig } from "./config";
import { scanAll, stats, ensureDb } from "./ingest/manager";
import { startWatcher, stopWatcher } from "./ingest/watcher";
import { runMcpServer } from "./mcp/server";
import { startHttpServer } from "./http";
import { searchMemories } from "./retrieve/search";
import { getEmbedProvider } from "./extract/provider";
import { extractQueue } from "./extract/extractor";
import { getDb } from "./store/db";

const HELP_TEXT = `Memoria — offline second brain for AI coding tools

Usage: memoria <command>

  server                 Headless mode: dashboard + API + MCP over HTTP (port 48210),
                         capture watcher and background jobs. No Electron needed.
  mcp                    MCP server over stdio
  scan                   Capture new sessions once
  recall "keywords"      Search memories
  status                 Counts per tool
  token                  Print the dashboard sign-in link and the API token
  import <export.zip>    Import a ChatGPT or Claude data export
  obsidian sync <dir>    Two-way sync with a Markdown / Obsidian folder
  brain <export|import|on|off> [project]  Team project brain in .memoria/brain.md
  hooks <install|remove|status>  Claude Code native hooks
  integrate <tool>       Register Memoria in an AI tool's MCP config
  handoff <slug>         Print the resume block for a project
  journal [days]         Learning journal: fixed errors, recurring first (default 7 days)
  maintain triage        Preview Tier 0 auto-triage (--apply, --undo)
  maintain backfill-events  Re-read Claude Code / OpenCode for todos, questions, verifier runs, commits
  maintain <reembed|consolidate|all>
  sync <setup|status|export|import|folder|conflicts>
  backup                 Back up the database

Data dir: ~/.memoria (override with MEMORIA_DATA_DIR)`;

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";

  switch (cmd) {
    case "scan": {
      const start = Date.now();
      const results = await scanAll((m) => console.log(m));
      console.table(results.map((r) => ({ tool: r.tool, status: r.ok ? "ok" : "failed", new: r.count, detail: r.detail })));
      const s = stats();
      console.log(`Transcripts: ${s.transcripts} | Memories: ${s.memories} | Time: ${((Date.now() - start) / 1000).toFixed(1)}s`);
      break;
    }
    case "extract": {
      ensureDb();
      const n = await extractQueue(true);
      console.log(`Extraction finished: ${n} new memories`);
      break;
    }
    case "recall": {
      const q = process.argv.slice(3).join(" ");
      if (!q) {
        console.log('Usage: node dist/engine/index.js recall "keywords"');
        process.exit(1);
      }
      ensureDb();
      const eprov = await getEmbedProvider();
      const qEmb = await eprov.embed(q);
      const hits = searchMemories(q, { limit: 8, embedModel: eprov.embedModel }, qEmb);
      for (const h of hits) {
        console.log(`[${h.kind}] (${h.projectSlug ?? "global"} · ${h.sourceTool} · ${h.score.toFixed(2)})`);
        console.log(`  ${h.content}`);
        console.log("");
      }
      if (!hits.length) console.log("No matching memories.");
      break;
    }
    case "mcp": {
      await runMcpServer();
      break;
    }
    case "backup": {
      ensureDb();
      const { manualBackupNow } = await import("./lifecycle");
      const p = manualBackupNow();
      console.log(p ? `Backup saved: ${p}` : "Backup failed.");
      break;
    }
    case "handoff": {
      const slug = process.argv[3];
      if (!slug) {
        console.log('Usage: node dist/engine/index.js handoff <slug>');
        process.exit(1);
      }
      ensureDb();
      const { generateHandoff, injectHandoff } = await import("./handoff");
      const md = await generateHandoff(slug);
      console.log(md);
      if (process.argv.includes("--inject")) {
        const r = await injectHandoff(slug);
        console.log("");
        console.log(`Inject to ${r.file}: ${r.ok ? "ok" : "failed"}`);
      }
      break;
    }
    case "integrate": {
      const tool = process.argv[3];
      if (!tool) {
        console.log('Usage: node dist/engine/index.js integrate <claude|codex|opencode|gemini>');
        process.exit(1);
      }
      const { registerIntegration } = await import("./integrate");
      const r = registerIntegration(tool);
      console.log(`${tool}: ${r.message}`);
      break;
    }
    case "sync": {
      ensureDb();
      const { runSyncCommand } = await import("./sync/cli");
      await runSyncCommand(process.argv.slice(3));
      break;
    }
    case "maintain": {
      ensureDb();
      const sub = process.argv[3] || "all";
      if (sub === "triage") {
        // maintain triage            → pratinjau (dry-run, tidak menulis apa pun)
        // maintain triage --apply    → terapkan, tercatat sebagai satu batch
        // maintain triage --undo     → batalkan batch terakhir
        const { runTriage, undoTriage } = await import("./extract/triage");
        const flags = process.argv.slice(4);
        if (flags.includes("--undo")) {
          const u = undoTriage();
          console.log(u.batch ? `Undo triage ${u.batch}: ${u.restored} memories restored to draft` : "No triage batch to undo");
          break;
        }
        const apply = flags.includes("--apply");
        const r = runTriage({ dryRun: !apply });
        console.log(`${apply ? "Triage applied" : "Triage preview (dry-run)"}: scanned ${r.scanned}, promote ${r.promoted}, archive ${r.archived}, keep ${r.kept}`);
        for (const [reason, n] of Object.entries(r.reasons).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${reason}`);
        for (const action of ["promote", "archive", "keep"] as const) {
          if (!r.samples[action].length) continue;
          console.log(`\n${action} — examples:`);
          for (const s of r.samples[action]) console.log(`  [${s.reason}] ${s.content.replace(/\s+/g, " ").slice(0, 120)}`);
        }
        if (!apply) console.log("\nRun with --apply to apply, --undo to revert the last batch.");
        else if (r.batch) console.log(`\nBatch ${r.batch}. Revert with: maintain triage --undo`);
        break;
      }
      if (sub === "backfill-events") {
        const { backfillEvents } = await import("./ingest/backfill");
        const r = await backfillEvents({ log: (m) => console.log(m) });
        console.log(`New transcripts: ${r.newTranscripts} | memories from events: ${r.memoriesCreated} | duplicate todo memories archived: ${r.duplicatesArchived}`);
        for (const [k, n] of Object.entries(r.events).sort()) console.log(`  ${k.padEnd(22)} ${n}`);
        if (r.batch) console.log(`Revert the duplicate archiving with: maintain triage --undo`);
        break;
      }
      if (sub === "heuristic-promote" || sub === "all") {
        const { promoteLegacyHeuristicDrafts } = await import("./extract/heuristic");
        const r = promoteLegacyHeuristicDrafts(2000);
        console.log(`Heuristic drafts: scanned ${r.scanned}, promoted ${r.promoted}, archived ${r.archived}`);
      }
      if (sub === "reembed" || sub === "all") {
        const { reembedAll } = await import("./sync/embed");
        const r = await reembedAll({ batch: 64 });
        console.log(`Re-embed: queued ${r.queued}, embedded ${r.embedded} (target ${r.targetModel})`);
      }
      if (sub === "consolidate") {
        const { consolidateMemories } = await import("./extract/consolidate");
        const r = await consolidateMemories();
        console.log(`Consolidation: removed ${r.removed} in ${r.clusters} clusters`);
      }
      if (!["heuristic-promote", "reembed", "all", "consolidate"].includes(sub)) {
        console.log("Usage: node dist/engine/index.js maintain <triage [--apply|--undo]|backfill-events|heuristic-promote|reembed|consolidate|all>");
        process.exit(1);
      }
      break;
    }
    case "server": {
      ensureDb();
      await startHttpServer();
      startWatcher();
      const { startBackgroundJobs, stopBackgroundJobs } = await import("./lifecycle");
      startBackgroundJobs();
      const { dashboardLoginUrl, tokenRequired } = await import("./auth");
      console.log(
        tokenRequired()
          ? `[memoria] Dashboard (open once to sign in): ${dashboardLoginUrl()}`
          : `[memoria] Dashboard: ${dashboardLoginUrl().replace(/\?token=.*/, "")} (API token disabled)`
      );
      console.log("[memoria] Watching sessions. Press Ctrl+C to stop.");
      process.on("SIGINT", () => {
        stopWatcher();
        stopBackgroundJobs();
        process.exit(0);
      });
      await new Promise(() => {});
      break;
    }
    case "hook": {
      // Called by Claude Code (see hooks/claude.ts). Never fails the caller.
      const { hookMain } = await import("./hooks/claude");
      await hookMain(process.argv[3] || "");
      process.exit(0);
    }
    case "hooks": {
      const sub = process.argv[3] || "status";
      const h = await import("./hooks/claude");
      if (sub === "install") {
        const { engineScriptPath, nodeCommand } = await import("./integrate");
        console.log(h.installClaudeHooks(nodeCommand(), engineScriptPath()).message);
      } else if (sub === "remove") {
        console.log(h.removeClaudeHooks().message);
      } else {
        console.log(h.claudeHooksInstalled() ? "Claude Code hooks: installed" : "Claude Code hooks: not installed (run: memoria hooks install)");
      }
      break;
    }
    case "import": {
      // memoria import <chatgpt-or-claude-export.zip | conversations.json>
      ensureDb();
      const file = process.argv[3];
      if (!file) {
        console.log("Usage: memoria import <export.zip | conversations.json>   (ChatGPT or Claude data export)");
        process.exit(1);
      }
      const { importChatExport } = await import("./import/chats");
      const r = importChatExport(file);
      console.log(`Imported ${r.conversations} ${r.source} conversations (${r.messages} messages, ${r.skipped} empty skipped)`);
      const { extractQueue } = await import("./extract/extractor");
      let n = 0;
      for (let i = 0; i < 200; i++) {
        const k = await extractQueue(true, { order: "desc" });
        if (!k) break;
        n += k;
      }
      const { runTriage } = await import("./extract/triage");
      const tr = runTriage();
      console.log(`Extracted ${n} memory candidates; triage: ${tr.promoted} active, ${tr.archived} archived, ${tr.kept} left for review`);
      break;
    }
    case "brain": {
      // memoria brain <export|import|on|off> [project path or name; default: cwd]
      ensureDb();
      const sub = process.argv[3] || "";
      const target = process.argv[4] || process.cwd();
      const { resolveProject } = await import("./store/db");
      const proj = resolveProject(target);
      if (!["export", "import", "on", "off"].includes(sub) || !proj) {
        console.log("Usage: memoria brain <export|import|on|off> [project]   (writes/reads .memoria/brain.md in the repo)");
        process.exit(1);
      }
      const brain = await import("./team/brain");
      if (sub === "on" || sub === "off") {
        brain.setBrainExport(proj.slug, sub === "on");
        console.log(`Brain export ${sub === "on" ? "enabled" : "disabled"} for ${proj.slug}`);
        if (sub === "off") break;
      }
      if (sub === "import") {
        const r = brain.importBrain(proj.slug);
        console.log(r ? `Imported ${r.file}: ${r.added} added, ${r.updated} updated, ${r.archived} archived, ${r.unchanged} unchanged` : "No .memoria/brain.md in this project");
        break;
      }
      const r = brain.exportBrain(proj.slug);
      console.log(`${r.changed ? "Wrote" : "Up to date:"} ${r.file} (${r.entries} entries)`);
      break;
    }
    case "obsidian": {
      // memoria obsidian sync <dir>
      ensureDb();
      const dir = process.argv[4] || (await import("./store/db")).getSetting("obsidianVault", "");
      if (process.argv[3] !== "sync" || !dir) {
        console.log("Usage: memoria obsidian sync <vault-folder>");
        process.exit(1);
      }
      const { syncObsidianVault } = await import("./export/obsidian");
      const r = syncObsidianVault(dir);
      if (!r.ok) {
        console.error(r.error);
        process.exit(1);
      }
      console.log(`Synced ${r.notes} notes in ${r.dir}: ${r.written} written, ${r.updatedFromNotes} updated from notes, ${r.createdFromNotes} new, ${r.archivedFromNotes} archived, ${r.conflicts} conflicts`);
      break;
    }
    case "journal": {
      // memoria journal [days]  — fixed errors of the period, recurring first
      ensureDb();
      const { learningJournal } = await import("./summary/journal");
      const days = Number(process.argv[3] || 7);
      console.log(learningJournal({ days: Number.isFinite(days) ? days : 7 }).markdown);
      break;
    }
    case "token": {
      // Print the local API token and the one-time dashboard sign-in link.
      ensureDb();
      const { getApiToken, dashboardLoginUrl, tokenFile, TOKEN_HEADER } = await import("./auth");
      console.log(`Dashboard sign-in : ${dashboardLoginUrl()}`);
      console.log(`Header for scripts: ${TOKEN_HEADER}: ${getApiToken()}`);
      console.log(`Stored in         : ${tokenFile()} (owner-only)`);
      break;
    }
    case "help":
    case "--help":
    case "-h": {
      console.log(HELP_TEXT);
      break;
    }
    case "status": {
      ensureDb();
      const s = stats();
      const cfg = getConfig();
      console.log(`Data dir   : ${cfg.dataDir}`);
      console.log(`Transcript : ${s.transcripts}`);
      console.log(`Memories   : ${s.memories}`);
      console.log(`Ollama     : http://localhost:11434 (extract model: ${cfg.ollamaExtractModel})`);
      const db = getDb();
      const perTool = db.prepare("SELECT tool, COUNT(*) AS c FROM transcripts GROUP BY tool").all() as Array<{ tool: string; c: number }>;
      for (const t of perTool) console.log(`  - ${t.tool}: ${t.c}`);
      break;
    }
    default: {
      console.error(`Unknown command: ${cmd}\n${HELP_TEXT}`);
      process.exitCode = 1;
      break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
