/** Role repair for Claude Code rows stored before v0.12.
 *
 * Claude Code sends tool results as `type: "user"` messages. Older parsers
 * stored them with role `user`, so shell output, file reads and edit
 * confirmations look like things the person said. The original jsonl is gone
 * for most of those sessions, so the role is recovered from the text alone.
 *
 * Checked against the 8,068 rows whose jsonl still exists on the
 * maintainer's machine: 96.5% of tool results become `tool`, 96.9% of
 * human messages stay `user`. Machine-injected messages (pasted image
 * markers, IDE tags, session continuation summaries) become `system`. */

export type LegacyRole = "user" | "tool" | "system";

const TOOL_PATTERNS: RegExp[] = [
  /^The file \S.* has been (?:updated|created)/,
  /^File created successfully at:/,
  /^File does not exist\./,
  /^\(Bash completed with no output\)/,
  /^Exit code:? \d+/m,
  /^\s*\d+[\t→]/, // numbered Read listing
  /^\d+:\s?\S/, // grep -n
  /^Async agent launched successfully/,
  /^Todos have been modified successfully/,
  /^(?:Web search results for query|Found \d+ files?|No files found|No matches found)/,
  /^The server-side auto mode classifier/,
  /^Permission for this action was denied/,
  /^<tool_use_error>/,
  /^(?:Your questions have been answered:|User has answered your questions|The user answered:|The user doesn't want to proceed)/,
  /Shell cwd was reset to /,
  /^Launching skill:/,
  /^The page (?:content )?you provided/,
  /^Command (?:did not complete within|running in background)/,
  /^Monitor started \(task/,
  /^The server returned HTTP \d/,
  /^\{"success":/,
  /^[0-9a-f]{7,40} \S/, // git log --oneline
  /^\[[\w/.-]+ [0-9a-f]{7}\]/, // git commit
  /^(?:M|A|D|R|\?\?) +\S+\.\w+/, // git status --short
  /^remote: /,
  /^npm (?:warn|error|ERR!)/,
  /^Error: /,
  /^Compiler run successful/,
  /^ls: /,
];

/** Every token is a file name or a path: output of ls/find/glob. Checked per
 * token because a single regex over the whole text backtracks badly. */
function isPathList(text: string): boolean {
  const tokens = text.trim().split(/\s+/);
  if (!tokens[0]) return false;
  if (tokens.every((t) => /^[\w@.[\]()/-]+\.\w{1,5}$/.test(t))) return true;
  // Absolute paths may contain spaces ("Personal Project"), so judge lines.
  const lines = text.trim().split("\n");
  return lines.every((l) => /^\/(?:[\w .@[\]()-]+\/)*[\w.@[\]()-]+\/?$/.test(l.trim()));
}

const SYSTEM_PATTERNS: RegExp[] = [
  /^\[Request interrupted by user/,
  /^This session is being continued from a previous conversation/,
  /^Base directory for this skill:/,
  /^Caveat: The messages below were generated/,
  /^Your response above was cut off mid-stream/,
  /^<task-notification>/,
  /^Fork started/,
  /^Another Claude session sent a message/,
  /^<artifact-content/,
];

const INJECTED = /<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics|command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g;
const IMAGE_MARKER = /\[Image: (?:source: [^\]]*|original \d+x\d+[^\]]*)\]/g;
const PASTED = /<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/g;
const WORD = /^\p{L}[\p{L}'’-]*[.,!?:;)]*$/u;
const CODE_CHAR = /[{};=<>[\]$|`\\]|0x[0-9a-f]/gi;

export function classifyLegacyClaudeRole(content: string): LegacyRole {
  // The head is enough to judge a message and bounds the regex work.
  const text = (content || "").trimStart().slice(0, 4000);
  if (TOOL_PATTERNS.some((p) => p.test(text)) || isPathList(text)) return "tool";
  if (SYSTEM_PATTERNS.some((p) => p.test(text))) return "system";
  const hadPaste = /<pasted_content\b/.test(text);
  // What the person typed, without pasted blocks, injected tags or paths.
  const typed = text.replace(PASTED, " ").replace(INJECTED, " ").replace(IMAGE_MARKER, " ").replace(/\S*\/\S+/g, " ").trim();
  if (!typed) return hadPaste ? "user" : "system";
  const tokens = typed.split(/\s+/);
  const words = tokens.filter((w) => WORD.test(w)).length;
  const lines = typed.split("\n").filter((l) => l.trim()).length;
  const codeDensity = (typed.match(CODE_CHAR) || []).length / typed.length;
  return words / tokens.length >= 0.7 && codeDensity < 0.02 && lines <= 4 ? "user" : "tool";
}
