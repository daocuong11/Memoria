/* Project scope follows the git work tree; the Claude Code hook does not
 * repeat what CLAUDE.md already holds. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const require = createRequire(import.meta.url);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memoria-scope-")));
process.env.MEMORIA_DATA_DIR = path.join(tmp, "data");
process.env.HOME = path.join(tmp, "home");
fs.mkdirSync(process.env.HOME);
const dbmod = require("../dist/engine/store/db.js");
dbmod.initDb(process.env.MEMORIA_DATA_DIR);
const { searchMemories, projectContext } = require("../dist/engine/retrieve/search.js");
const { fileContext } = require("../dist/engine/retrieve/filecontext.js");
const scope = require("../dist/engine/retrieve/scope.js");
const { sessionStartContext } = require("../dist/engine/hooks/claude.js");

// repo/ (git) with repo/contracts and repo/web as separate projects; a nested
// repo inside it; and a plain folder outside git next to it.
const repo = path.join(tmp, "repo");
const contracts = path.join(repo, "contracts");
const web = path.join(repo, "web");
const nested = path.join(repo, "vendor", "lib");
const plain = path.join(tmp, "notes");
for (const d of [contracts, web, nested, plain]) fs.mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", repo]);
execFileSync("git", ["init", "-q", nested]);
const pid = (p) => dbmod.ensureProject(dbmod.projectSlugFromCwd ? dbmod.projectSlugFromCwd(p) : path.basename(p), p);
const ids = { repo: pid(repo), contracts: pid(contracts), web: pid(web), nested: pid(nested), plain: pid(plain) };
const mem = (projectId, kind, content) =>
  dbmod.insertMemory({ projectId, kind, content, importance: 0.6, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic" });
mem(ids.contracts, "error_fixed", "Deploy script failed: RPC_URL missing in contracts/.env, fixed by adding it.");
mem(ids.web, "decision", "Web app reads the contract address from deployments/base.json.");
mem(ids.nested, "fact", "Vendored lib deploy notes are kept upstream.");
mem(ids.plain, "fact", "Personal deploy checklist lives in this notes folder.");

test("scope = same git work tree, nested repos and non-git folders excluded", () => {
  scope.resetScopeCache();
  const s = scope.projectScopeIds(ids.web);
  assert.ok(s.has(ids.repo) && s.has(ids.contracts) && s.has(ids.web));
  assert.ok(!s.has(ids.nested), "a nested repository is its own scope");
  assert.ok(!s.has(ids.plain));
  assert.deepEqual([...scope.projectScopeIds(ids.plain)], [ids.plain], "outside git: exact project only");
});

test("scoped recall, project context and file context see the whole repository", () => {
  const slug = (id) => dbmod.projectSlugById(id);
  const hits = searchMemories("deploy", { projectSlug: slug(ids.web) });
  assert.ok(hits.some((h) => /RPC_URL/.test(h.content)), "fix recorded in repo/contracts is found from repo/web");
  assert.ok(!hits.some((h) => /Vendored|checklist/.test(h.content)), "nested repo and outside folder stay out");
  assert.ok(projectContext(slug(ids.repo)).some((h) => /deployments\/base\.json/.test(h.content)));
  assert.ok(fileContext("contracts/.env", { project: web }).length >= 1);
  assert.equal(searchMemories("deploy", { projectSlug: slug(ids.plain) }).length, 1);
});

test("SessionStart hook skips lines already in CLAUDE.md", async () => {
  dbmod.insertMemory({ projectId: ids.contracts, kind: "task_pending", content: "Verify the contract on Basescan after deploy.", importance: 0.7, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic" });
  // Create the file first: its own appearance in `git status` must not change the context.
  fs.writeFileSync(path.join(contracts, "CLAUDE.md"), "# Notes\n");
  const full = await sessionStartContext(contracts);
  assert.match(full, /Basescan/);
  // CLAUDE.md that already holds every line of that context.
  fs.writeFileSync(path.join(contracts, "CLAUDE.md"), "# Notes\n\n<!-- memoria:start -->\n" + full + "\n<!-- memoria:end -->\n");
  const again = await sessionStartContext(contracts);
  assert.match(again, /resume block for this project is in CLAUDE\.md/);
  assert.ok(again.length < full.length / 2);
  // A new line not yet in CLAUDE.md is still sent.
  dbmod.insertMemory({ projectId: ids.contracts, kind: "task_pending", content: "Rotate the deployer key before mainnet.", importance: 0.8, createdAt: Date.now(), lastAccessed: 0, accessCount: 0, sourceTool: "claude", status: "active", origin: "heuristic" });
  const fresh = await sessionStartContext(contracts);
  assert.match(fresh, /Rotate the deployer key/);
  assert.ok(!/Basescan/.test(fresh), "lines already in CLAUDE.md are not repeated");
});
