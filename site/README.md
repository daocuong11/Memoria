# Memoria landing page

This folder holds the public landing page for Memoria. It is separate from the
app: `web/` is the in-app dashboard, `src/` is the engine. Nothing in `site/`
ships in the npm package or the desktop app.

**Pick any stack you like.** Plain HTML/CSS, Astro, Vite, Next.js static export,
SvelteKit static, Eleventy — the deploy workflow adapts to what it finds here.

## The brief

**Goal:** a developer who lands here understands what Memoria does in five
seconds, then installs it or stars the repo.

**Audience:** developers who use more than one AI coding tool (Claude Code,
Codex, Gemini CLI, Copilot, Cursor…) and lose context when switching, often
because they hit a usage limit mid-task.

**Main message:** your AI tools forget; Memoria doesn't. One local memory shared
by every AI coding tool. Nothing leaves your computer.

**Calls to action, in order:**
1. Copy the install command: `npx @xinzzu/memoria@latest server`
2. Download the desktop app: https://github.com/xinzzu/Memoria/releases/latest
3. Star on GitHub: https://github.com/xinzzu/Memoria

**Suggested sections** (reorder freely):
1. Hero: headline, one-line subhead, install command with a copy button, demo GIF.
2. The problem: switching tools or hitting a limit means explaining everything again.
3. How it works: capture sessions → extract decisions, tasks and fixed errors → recall in any tool over MCP, plus a resume block injected into AGENTS.md / CLAUDE.md / GEMINI.md.
4. Supported tools: capture from 9 tools, one-click MCP setup for 12 clients (see the Highlights table in the root README for the exact lists).
5. Privacy: 100% local SQLite, works with no model at all, optional Ollama or any OpenAI-compatible endpoint, secrets redacted, optional end-to-end encrypted sync with no server.
6. Install: desktop downloads per OS + the `npx` command for headless use.
7. Footer: GitHub, npm (`@xinzzu/memoria`), MIT licence, XERJ Corpus Hub badge.

**Facts you can quote** (all from the root README; check it before launch,
numbers change between releases):
- Capture from 9 tools; MCP registration for 12 clients; 9 MCP tools.
- Retrieval benchmark: hit@5 92.8–100% with zero LLM calls.
- Runs on Windows, macOS (Apple Silicon and Intel) and Linux. Node 22.5+ for the CLI.
- MIT licence. Listed on the official MCP Registry as `io.github.xinzzu/memoria`.

**Do not claim** cloud features, accounts, team plans, or signed/notarized
builds — none of these exist yet.

## Brand

| Token | Value |
|---|---|
| Background | `#0a0c10` |
| Panel / panel 2 | `#12151b` / `#171b22` |
| Border | `#242935` |
| Text / muted / faint | `#e9ecf3` / `#8d95a6` / `#5d6575` |
| Accent (blue) | `#6e8dff` |
| Accent 2 (violet) | `#8b6eff` |
| Green / amber / red | `#4cc38a` / `#d9a05b` / `#e5686b` |
| Font | Inter, system UI fallback |
| Mono | JetBrains Mono, Menlo, Consolas |

Dark theme first. No emoji in UI chrome (same rule as the app).

## Shared assets

Logo, banner, demo GIF, social preview and dashboard screenshots live in the
repo root and `docs/img/`. Do not copy them into `site/` by hand; run:

```bash
node scripts/site-assets.mjs site/public   # framework with a public/ dir
node scripts/site-assets.mjs site          # plain static site
```

They land in `<dir>/shared/` (git-ignored), e.g. `shared/logo.png`,
`shared/demo.gif`. The deploy workflow runs the same script on the build output,
so `/shared/...` paths work in production too.

## Deploy contract

GitHub Pages, workflow `.github/workflows/pages.yml`. It is **off** until the
maintainer sets Settings → Pages → Source to "GitHub Actions" and adds the repo
variable `SITE_ENABLED=true` (Settings → Secrets and variables → Actions →
Variables). After that, on every push to `main` that touches `site/**`:

- **If `site/package.json` exists:** runs `npm ci` (or `npm install` when there is
  no lockfile) and `npm run build` inside `site/`, then publishes `site/dist/`.
  Configure your tool to output to `dist/`.
- **Otherwise:** publishes `site/` as-is (plain HTML). `site/index.html` is the
  entry point.

**Base path:** the site is served from `https://xinzzu.github.io/Memoria/` until a
custom domain is set, so asset URLs must work under `/Memoria/`. The workflow
exports `SITE_BASE=/Memoria/` (or `/` once `site/CNAME` exists); read it in your
config, e.g. Astro `base: process.env.SITE_BASE`, Vite `base: process.env.SITE_BASE`.
Relative URLs (`./shared/logo.png`) work everywhere without config.

**Custom domain:** add `site/CNAME` containing just the domain (for a framework,
put it in `site/public/CNAME` so it ends up in `dist/`).

## Rules of thumb

- Keep it fast: no heavy client framework needed for a one-page site; the
  demo GIF is 2.8 MB, so lazy-load anything below the fold.
- No tracking scripts. Memoria's pitch is privacy; if analytics are needed, use a
  cookie-less, self-hostable option and say so on the page.
- Accessible: real text (not text in images), alt text, visible focus, good
  contrast on the dark background.
- English first. Other languages are welcome later (`/id/`, `/hi/`).

## Working on it

```bash
git checkout -b feat/landing
# build the site inside site/
node scripts/site-assets.mjs site/public   # or: site
# open a pull request against main
```

Pull requests run the normal CI; the page deploys after merge.

## Release history
The `changelog/` page is generated at deploy time from the root `CHANGELOG.md` by
`scripts/site-changelog.mjs` (styles in `style.css`, "Changelog page"). Do not commit a
built `changelog/` folder; edit `CHANGELOG.md` instead.
