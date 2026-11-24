// Builds the landing page's release history (<dir>/changelog/index.html) from
// CHANGELOG.md, so the page never drifts from the file.
// Usage: node scripts/site-changelog.mjs <dir>   e.g. site, _site
// Handles the subset of Markdown CHANGELOG.md uses: ## / ### headings,
// nested "- " lists with wrapped lines, paragraphs, "> " notes, `code`,
// **bold**, [links](url) and #123 references.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/site-changelog.mjs <dir>");
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/xinzzu/Memoria";
const src = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const url = /^(https?:|mailto:|#)/.test(u) ? u : `${REPO}/blob/main/${u.replace(/^\.\//, "")}`;
    return `<a href="${url}">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])#(\d{2,5})\b/g, `$1<a href="${REPO}/pull/$2">#$2</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

/** Render list items [{ depth, text }] as nested <ul>. */
function renderList(items) {
  let html = "";
  const open = []; // depths of open <ul>
  for (const it of items) {
    if (!open.length || it.depth > open[open.length - 1]) {
      html += "<ul>";
      open.push(it.depth);
    } else {
      while (open.length > 1 && it.depth < open[open.length - 1]) {
        html += "</li></ul>";
        open.pop();
      }
      html += "</li>";
    }
    html += `<li>${inline(it.text)}`;
  }
  while (open.length) {
    html += "</li></ul>";
    open.pop();
  }
  return html;
}

/** Parse CHANGELOG.md into releases: { version, date, name, html }. */
export function parse(md) {
  const releases = [];
  let cur = null;
  let html = [];
  let para = [];
  let list = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list.length) html.push(renderList(list));
    list = [];
  };
  const flush = () => {
    flushPara();
    flushList();
  };
  const finish = () => {
    flush();
    if (cur && html.length) releases.push({ ...cur, html: html.join("\n") });
    html = [];
  };
  for (const line of md.split("\n")) {
    const h2 = /^## \[([^\]]+)\](.*)$/.exec(line);
    if (h2) {
      finish();
      const parts = h2[2].split(/\s+[—-]\s+/).map((x) => x.trim()).filter(Boolean);
      cur = { version: h2[1], date: parts[0] || "", name: parts.slice(1).join(" — ") };
      continue;
    }
    if (!cur) continue; // title and intro
    const h3 = /^###\s+(.*)$/.exec(line);
    const li = /^(\s*)- (.*)$/.exec(line);
    if (h3) {
      flush();
      html.push(`<h3>${inline(h3[1])}</h3>`);
    } else if (li) {
      flushPara();
      list.push({ depth: Math.floor(li[1].length / 2), text: li[2] });
    } else if (/^\s*$/.test(line)) {
      flushPara();
    } else if (list.length && /^\s+\S/.test(line)) {
      list[list.length - 1].text += " " + line.trim();
    } else if (/^>\s?/.test(line)) {
      flush();
      html.push(`<p class="note">${inline(line.replace(/^>\s?/, ""))}</p>`);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  finish();
  return releases;
}

const releases = parse(src);
// Link "Release page" only for versions that were tagged (v0.13.0 never was).
let tags = null;
try {
  tags = new Set(execFileSync("git", ["tag", "-l", "v*"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean));
  if (!tags.size) tags = null;
} catch {
  tags = null;
}
const tagged = (v) => /^\d/.test(v) && (!tags || tags.has(`v${v}`));
const slug = (v) => "v" + v.replace(/[^\w.-]/g, "");
const index = releases
  .map((r) => `<li><a href="#${slug(r.version)}">${esc(r.version)}</a></li>`)
  .join("");
const body = releases
  .map(
    (r) => `<article class="release" id="${slug(r.version)}">
  <header>
    <h2><a href="#${slug(r.version)}">${esc(r.version)}</a>${r.name ? ` <span>${esc(r.name)}</span>` : ""}</h2>
    ${r.date ? `<time datetime="${esc(r.date)}">${esc(r.date)}</time>` : ""}
    ${tagged(r.version) ? `<a class="gh" href="${REPO}/releases/tag/v${esc(r.version)}">Release page</a>` : ""}
  </header>
  <div class="prose">
${r.html}
  </div>
</article>`
  )
  .join("\n");

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Changelog · Memoria</title>
  <meta name="description" content="Every Memoria release, with what changed and the numbers behind it.">
  <meta name="theme-color" content="#0a0c10">
  <link rel="canonical" href="https://memoria.xinzzu.web.id/changelog/">
  <link rel="icon" type="image/png" sizes="128x128" href="../favicon.png">
  <link rel="stylesheet" href="../style.css">
</head>
<body class="changelog-page">
  <a class="skip" href="#main">Skip to content</a>
  <header class="nav">
    <div class="wrap">
      <a class="brand" href="../" aria-label="Memoria home"><img class="brand-mark" src="../favicon.png" width="28" height="28" alt="">Memoria</a>
      <nav aria-label="Primary">
        <ul>
          <li><a class="link" href="../#how">How it works</a></li>
          <li><a class="link" href="../#install">Install</a></li>
          <li><a class="link" href="./" aria-current="page">Changelog</a></li>
          <li><a class="btn" href="${REPO}">GitHub</a></li>
        </ul>
      </nav>
    </div>
  </header>
  <main id="main" class="wrap cl">
    <h1>Changelog</h1>
    <p class="lead">Every release of Memoria, newest first. Generated from <a href="${REPO}/blob/main/CHANGELOG.md">CHANGELOG.md</a>.</p>
    <nav class="cl-index" aria-label="Releases"><ul>${index}</ul></nav>
${body}
  </main>
  <footer>
    <div class="wrap">
      <ul>
        <li><a href="../">Home</a></li>
        <li><a href="${REPO}">GitHub</a></li>
        <li><a href="https://www.npmjs.com/package/@xinzzu/memoria">npm</a></li>
        <li><a href="${REPO}/releases">Releases</a></li>
        <li><a href="${REPO}/blob/main/LICENSE">MIT license</a></li>
      </ul>
    </div>
  </footer>
</body>
</html>
`;

const dir = path.resolve(out, "changelog");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "index.html"), page);
console.log(`changelog: ${releases.length} releases → ${path.relative(process.cwd(), dir) || dir}/index.html`);
