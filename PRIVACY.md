# Privacy

Memoria runs on your machine. It has no account, no server of its own, and no telemetry. This page lists what it reads, where it keeps it, and the only ways anything leaves your computer. Each of those ways is something you turn on yourself.

## What Memoria reads

- **Session files of AI coding tools**, read-only, from their usual folders:
  - Claude Code: `~/.claude/projects`
  - Codex CLI: `~/.codex/sessions`
  - OpenCode: `opencode.db`
  - Gemini CLI and Antigravity: `~/.gemini`
  - Copilot, VS Code, Cursor and Windsurf: their chat storage

  Each source can be turned off in Settings. Folders listed under *Capture exclusions* are skipped.
- **Git metadata** of a project folder (branch, changed files, recent commit subjects) for the resume block.
- **Exports you import yourself** (ChatGPT / Claude data exports, Markdown folders).

It does not read your source code. Two exceptions: the lifecycle check looks up whether files named in a memory still exist (without reading them), and the team brain reads `.memoria/brain.md` in a project.

## Where it is stored

- Everything lives in one data folder: `~/.memoria` by default, or `MEMORIA_DATA_DIR`. It holds `memory.db` (SQLite), `backups/`, and `archive/` (old transcripts you chose to archive).
- On macOS and Linux the folder is `0700` and its files `0600`, so other accounts on the machine cannot read them.
- Secrets are masked **before** anything is stored, in transcripts, memories and session events alike. That covers provider API keys (OpenAI, Anthropic, GitHub, AWS, Google, Stripe, Slack, …), JWTs, connection-string passwords, bearer tokens, `NAME_KEY=value` assignments, PEM private keys, labelled 32-byte hex private keys, keypair byte arrays, and anything you wrap in `<private>…</private>`. Public addresses and transaction hashes are kept on purpose.
- API keys you give Memoria (OpenAI-compatible provider, webhooks) are encrypted with the OS keychain where available.

## What can leave your machine (all opt-in)

| Feature | What is sent | Where |
|---|---|---|
| LLM extraction with **Ollama** | transcript text | your local Ollama (`localhost`) |
| LLM extraction / embeddings with an **OpenAI-compatible provider** | transcript text, memory text | the endpoint you configure |
| **Sync** | memories, projects, links, tags; never transcripts or session events | a folder you choose (e.g. a synced drive), encrypted with AES-256-GCM under a key derived from your passphrase (scrypt) |
| **Webhooks** (Discord, Telegram, generic) | short summaries of events you enable | the URL you configure |
| **Team brain** (`.memoria/brain.md`) | a project's current decisions and tasks | a file in that repository, so it travels wherever the repository goes |
| **Resume blocks** (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) | the latest resume for that project | files in the project folder (each can be turned off) |

## Who can talk to Memoria locally

- The dashboard and the HTTP MCP endpoint listen on `127.0.0.1` only. They require a local API token, check the Host header and refuse cross-origin requests.
- The stdio MCP server is started by the AI tool you registered it with, and runs as your user.

## Keeping and deleting

- `memoria maintain retention` previews old transcripts and moves them to a gzip archive in the data folder. `--delete` removes them permanently instead. Memories are not affected.
- Memories can be archived or deleted one by one in the dashboard, or with the MCP tool `forget`.
- To remove everything, quit Memoria and delete the data folder, plus any `.memoria/brain.md` files. Resume blocks sit between `<!-- memoria:start -->` and `<!-- memoria:end -->` in `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`. The local API `POST /api/handoff/remove` removes them for one project; you can also delete the marked lines yourself.

## Logs that stay local

- The **retrieval inspector** keeps the last 500 context-tool calls (redacted queries, returned memory ids). It is never synced, and can be paused or cleared in the Retrievals tab.
- Context usage counters (how many characters were served) stay in the database.

Questions or a privacy problem: see [SECURITY.md](SECURITY.md) for how to report it.
