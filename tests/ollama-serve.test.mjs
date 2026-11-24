import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findOnPath, spawnServe } from "../dist/engine/extract/ollama-serve.js";

test("findOnPath returns null when the command is not installed", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mem-path-"));
  assert.equal(findOnPath("ollama", empty), null);
});

test("spawnServe on a missing binary does not throw or emit an uncaught error", async () => {
  let uncaught = null;
  const onErr = (e) => { uncaught = e; };
  process.on("uncaughtException", onErr);
  try {
    assert.equal(spawnServe("/nonexistent/ollama-" + Date.now()), true);
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    process.off("uncaughtException", onErr);
  }
  assert.equal(uncaught, null);
});
