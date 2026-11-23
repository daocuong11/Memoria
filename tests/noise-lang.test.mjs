/* Language noise files: shape checks for every file (so a contributed
 * language cannot break triage), registration, and matching behaviour. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const lang = require("../dist/engine/extract/noise-lang/index.js");
const { noiseReason } = require("../dist/engine/extract/noise.js");
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "engine", "extract", "noise-lang");
const KNOWN_IDS = new Set(["agent-narration", "offer-question", "generic-agent"]);

test("every language file is valid and registered", () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 2);
  const registered = new Set(lang.LANGUAGE_FILES.map((f) => f.language));
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(SRC, f), "utf8"));
    const code = f.replace(/\.json$/, "");
    assert.equal(d.language, code, `${f}: "language" must equal the file name`);
    assert.ok(registered.has(code), `${f} is not imported in noise-lang/index.ts`);
    assert.ok(typeof d.name === "string" && d.name.length > 1, `${f}: "name" is required`);
    assert.ok(Array.isArray(d.rules) && d.rules.length, `${f}: "rules" must be a non-empty list`);
    for (const r of d.rules) {
      assert.ok(KNOWN_IDS.has(r.id), `${f}: unknown rule id "${r.id}" (use one of ${[...KNOWN_IDS].join(", ")})`);
      assert.ok(r.at === "start" || r.at === "anywhere", `${f}/${r.id}: "at" must be "start" or "anywhere"`);
      assert.ok(Array.isArray(r.phrases) && r.phrases.length, `${f}/${r.id}: "phrases" must be a non-empty list`);
      const seen = new Set();
      for (const p of r.phrases) {
        assert.equal(typeof p, "string", `${f}/${r.id}: phrases are strings`);
        const n = lang.normalizePhrase(p);
        assert.ok(n.length >= 2, `${f}/${r.id}: phrase "${p}" is too short`);
        assert.ok(n.split(" ").length <= 6, `${f}/${r.id}: phrase "${p}" is longer than 6 words`);
        assert.ok(!/[\\^$*+?()[\]{}|]/.test(p), `${f}/${r.id}: "${p}" looks like a regex; use plain words`);
        assert.ok(!seen.has(n), `${f}/${r.id}: duplicate phrase "${p}"`);
        seen.add(n);
      }
    }
  }
});

test("matching: whole words, apostrophes and commas ignored, both languages", () => {
  const cases = {
    "Let me check the config file first.": "agent-narration",
    "Let’s run the tests again now please.": "agent-narration",
    "Okay, now I will update the handler for login.": "agent-narration",
    "Saya akan cek file konfigurasi dulu sebelum lanjut.": "agent-narration",
    "Saya mulai kerjakan sambil build sebelumnya jalan.": "agent-narration",
    "Mau saya lanjutkan jadi file PRD.md + skema SQL?": "offer-question",
    "Would you like me to add tests for the parser too?": "offer-question",
    "Deployed the fix; hope this helps with the release.": "generic-agent",
    "Semoga membantu ya kalau ada pertanyaan lagi.": "generic-agent",
  };
  for (const [text, id] of Object.entries(cases)) assert.equal(noiseReason(text), id, text);
  const keep = [
    "Readings from the sensor are stored in Postgres daily.",
    "Let measure performance with a benchmark before merge.",
    "Use pnpm workspaces because they are faster here.",
    "Checkout uses Stripe; refunds go through the admin panel.",
  ];
  for (const text of keep) assert.equal(noiseReason(text), null, text);
});
