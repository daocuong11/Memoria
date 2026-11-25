/* `memoria --version` prints the version from package.json. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function runCli(args) {
  // Isolated data dir so the real memories are never touched.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memoria-version-")));
  const env = { ...process.env, MEMORIA_DATA_DIR: path.join(tmp, "data"), HOME: tmp };
  return execFileSync(process.execPath, [path.join(root, "dist/engine/index.js"), ...args], { encoding: "utf8", env });
}

test("memoria --version prints the version from package.json", () => {
  assert.equal(runCli(["--version"]).trim(), pkg.version);
});

test("memoria -v and memoria version print the same version", () => {
  assert.equal(runCli(["-v"]).trim(), pkg.version);
  assert.equal(runCli(["version"]).trim(), pkg.version);
});

test("memoria help lists the --version flag", () => {
  assert.match(runCli(["help"]), /--version/);
});
