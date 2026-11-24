/* Structured session events (quality phase Q2a). The agent's own task list,
 * questions it asked and the answers it got, and session titles are explicit
 * data in the transcript: no sentence heuristics are needed to find them.
 * These pure functions turn source records into SessionEvent fields; the
 * parsers add tool/session/project/time and store them (session_events). */

export interface TodoItem {
  content: string;
  /** pending | in_progress | completed | cancelled */
  status: string;
}

export interface AnsweredQuestion {
  question: string;
  header: string;
  options: string[];
  /** Empty when the question went unanswered. */
  answer: string;
}

export interface EventDraft {
  type: "todo_list" | "question" | "title" | "file_edit" | "command" | "commit";
  sourceRef: string;
  payload: Record<string, unknown>;
}

const TODO_TOOLS = /^(?:todo_?write|mcp__ccd_turn__update_plan)$/i;
const STATUS: Record<string, string> = {
  pending: "pending",
  todo: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  active: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  cancelled: "cancelled",
  canceled: "cancelled",
};

export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const content = String(o.content ?? o.text ?? o.title ?? o.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!content || seen.has(content.toLowerCase())) continue;
    seen.add(content.toLowerCase());
    out.push({ content, status: STATUS[String(o.status ?? "").toLowerCase()] ?? "pending" });
  }
  return out;
}

/** Todo lists from one assistant message (Claude content blocks). */
export function claudeTodoEvents(content: unknown): EventDraft[] {
  if (!Array.isArray(content)) return [];
  const out: EventDraft[] = [];
  for (const b of content) {
    if (!b || typeof b !== "object" || (b as any).type !== "tool_use" || !TODO_TOOLS.test(String((b as any).name || ""))) continue;
    const input = (b as any).input || {};
    const items = normalizeTodos(input.todos ?? input.items);
    if (items.length) out.push({ type: "todo_list", sourceRef: String((b as any).id || ""), payload: { items } });
  }
  return out.filter((e) => e.sourceRef);
}

function cleanLabel(s: unknown): string {
  return String(s ?? "")
    .replace(/\s*\((?:Recommended|Disarankan)\)/gi, "")
    .replace(/,\s*(?:Recommended|Disarankan)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function questionsFrom(qs: unknown, answerOf: (q: Record<string, unknown>, i: number) => unknown): AnsweredQuestion[] {
  if (!Array.isArray(qs)) return [];
  return qs
    .filter((q) => q && typeof q === "object")
    .map((q, i) => {
      const o = q as Record<string, unknown>;
      const a = answerOf(o, i);
      const answer = Array.isArray(a) ? a.map(cleanLabel).filter(Boolean).join(", ") : cleanLabel(a);
      return {
        question: String(o.question ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
        header: String(o.header ?? "").trim().slice(0, 100),
        options: Array.isArray(o.options) ? o.options.map((x: any) => cleanLabel(x?.label ?? x)).filter(Boolean).slice(0, 10) : [],
        answer: answer.slice(0, 1000),
      };
    })
    .filter((q) => q.question);
}

/** Claude Code `AskUserQuestion`: the user line carrying the tool result has
 * `toolUseResult: { questions, answers: { [question]: answer } }`. */
export function claudeQuestionEvent(line: Record<string, unknown>): EventDraft | null {
  const r = line.toolUseResult as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || !Array.isArray(r.questions) || !r.answers || typeof r.answers !== "object") return null;
  const content = (line.message as any)?.content;
  const block = Array.isArray(content) ? content.find((b: any) => b && b.type === "tool_result") : null;
  const ref = String(block?.tool_use_id || line.uuid || "");
  if (!ref) return null;
  const answers = r.answers as Record<string, unknown>;
  const questions = questionsFrom(r.questions, (q) => answers[String(q.question ?? "")]);
  return questions.length ? { type: "question", sourceRef: ref, payload: { questions } } : null;
}

/** OpenCode `question` tool part: answers are aligned with the questions in
 * `state.metadata.answers` (one array of labels per question). */
export function opencodeQuestionEvent(part: Record<string, any>, ref: string): EventDraft | null {
  const st = part.state || {};
  if (st.status !== "completed") return null;
  const answers = Array.isArray(st.metadata?.answers) ? st.metadata.answers : [];
  const questions = questionsFrom(st.input?.questions, (_q, i) => answers[i]);
  return questions.length ? { type: "question", sourceRef: ref, payload: { questions } } : null;
}

/* ---------- Verifier runs, file edits, commits (Q2b) ----------
 * A build/test/typecheck command is a "verifier". Whether it failed is read
 * from its OUTPUT: most real runs are piped (`npm run build 2>&1 | tail`),
 * which hides the exit code. */

const VERIFIER =
  /(?:^|[\s;&|(])((?:npm|pnpm|yarn|bun) (?:run )?(?:test|build|lint|typecheck|type-check|check|tsc)\b|npx (?:tsc|vitest|jest|eslint|next build|vite build|hardhat (?:test|compile)|playwright test)\b|(?:^|\s)tsc\b|pytest\b|python3? -m (?:pytest|unittest)\b|cargo (?:build|test|check|clippy)\b|forge (?:build|test)\b|go (?:build|test|vet)\b|node --test\b|anchor (?:build|test)\b|mvn (?:test|package|compile)\b|gradle(?:w)? (?:test|build)\b|make (?:test|build|check)\b)/;

/** Normalized verifier name (`npm run build`, `npx tsc`), or null. `cd …`,
 * env assignments and everything after a pipe do not change the name. */
export function verifierName(command: string): string | null {
  const m = String(command || "").match(VERIFIER);
  if (!m) return null;
  return m[1]
    .trim()
    .replace(/^(npm|pnpm|yarn|bun) (test|build|lint|typecheck|type-check|check)$/, "$1 run $2")
    .replace(/^(npm|pnpm|yarn|bun) run test$/, "$1 test")
    .replace(/^python3? -m /, "python -m ");
}

/** Specific causes first; summaries ("Failed to compile.", "3 failed")
 * only when the output shows nothing more precise. */
const FAILURE: RegExp[] = [
  /error TS\d+:[^\n]*/,
  /Type error:[^\n]*/,
  /Module not found:[^\n]*/,
  /error\[E\d+\][^\n]*/,
  /Error \(\d+\):[^\n]*/, // solc
  /\[FAIL[.:][^\n]*/, // forge test
  /SyntaxError:[^\n]*/,
  /ReferenceError:[^\n]*/,
  /TypeError:[^\n]*/,
  /AssertionError[^\n]*/,
  /panicked at[^\n]*/,
  /^E\s+\w+Error:[^\n]*/m, // pytest
  /^FAIL\s+\S[^\n]*/m,
  /^\s*✖\s+(?!\d+ problems? \()\S[^\n]*/m, // node --test
  /^Error: (?!Turbopack build failed)[^\n]{8,}/m,
  /Failed to compile[^\n]*/,
  /Turbopack build failed[^\n]*/,
  /Build failed[^\n]*/,
  /Compiler run failed[^\n]*/,
  /\b[1-9]\d* (?:failing|failed)\b[^\n]*/,
  /^\s*✖\s+\d+ problems? \((?!0 errors?,)[^\n]*/m, // eslint with errors
  /npm ERR![^\n]*/,
];
/** Lines that are about the environment (network, RPC, a missing script),
 * not about the code: a fix to the code cannot be credited for them. */
const ENVIRONMENT = /socket connection was closed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|server returned an error response|rate limit|Cannot find module '\/|getaddrinfo|network error|timed? ?out\b|fork endpoint|forked environment|HTTP request failed|tls handshake|error sending request/i;
/** Lines a verifier can produce itself; for `tsc` only compiler errors count. */
export function errorBelongsTo(verifier: string, line: string): boolean {
  if (!line || ENVIRONMENT.test(line)) return false;
  if (/(^|\s)tsc$/.test(verifier)) return /error TS\d+:/.test(line);
  return true;
}

/** Output that says the run passed wins over a stray "error" word in a log line. */
const SUCCESS = /\b(?:0 errors?|0 failed|Compiled successfully|compiled successfully|All tests passed|tests? passed|✓ Ready|Finished `\w+` profile|Compiler run successful)\b/i;

/** The first line that says why the run failed, or "" when the output does
 * not show a failure. */
export function failureLine(output: string): string {
  const text = String(output || "").slice(-20000);
  for (const re of FAILURE) {
    const m = text.match(re);
    if (m) return m[0].replace(/\s+/g, " ").trim().slice(0, 240);
  }
  return "";
}

export function runFailed(output: string, exitCode?: number | null, isError?: boolean): { failed: boolean; errorLine: string } {
  const errorLine = failureLine(output);
  if (errorLine) return { failed: true, errorLine };
  if (SUCCESS.test(output)) return { failed: false, errorLine: "" };
  // Without an error line a non-zero exit still counts as failed, but such a
  // run can never anchor an error→fix memory (it needs the error line).
  return { failed: !!isError || (exitCode != null && exitCode !== 0), errorLine: "" };
}

const NOT_PROJECT = /(?:^|[\/])(?:\.claude|\.cursor|\.vscode|\.idea|node_modules|\.next|dist|build)[\/]|(?:^|[\/])(?:\.mcp\.json|settings\.local\.json)$/;
const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|rs|go|sol|java|kt|swift|rb|php|cs|cpp|cc|c|h|hpp|vue|svelte|css|scss|sql|prisma|toml|ya?ml|json|graphql|proto|sh)$/i;
const NOT_CODE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|CHANGELOG\.md)$/i;
export function isCodeFile(p: string): boolean {
  return CODE_EXT.test(p) && !NOT_CODE.test(p) && !NOT_PROJECT.test(p);
}

export interface CommitInfo {
  sha: string;
  message: string;
}

/** `git commit` with its message (from -m or a heredoc) and sha (from the
 * `[branch sha] subject` line, or a `git log --oneline` line after it). */
export function commitFrom(command: string, output: string): CommitInfo | null {
  const cmd = String(command || "");
  if (!/\bgit commit\b/.test(cmd) || /--dry-run/.test(cmd)) return null;
  const out = String(output || "");
  if (/nothing to commit|no changes added to commit/i.test(out)) return null;
  let message = "";
  const m = cmd.match(/\s-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/);
  if (m) message = (m[1] ?? m[2] ?? "").replace(/\\"/g, '"');
  if (!message) {
    const h = cmd.match(/<<\s*'?"?(\w+)'?"?\s*\n([\s\S]*?)\n\1\b/);
    if (h) message = h[2];
  }
  const subject = message.split("\n").map((l) => l.trim()).find(Boolean) || "";
  const bracket = out.match(/\[[\w./-]+ (?:\(root-commit\) )?([0-9a-f]{7,40})\]\s*([^\n]*)/);
  const oneline = out.match(/^([0-9a-f]{7,40}) (.+)$/m);
  const sha = bracket?.[1] || (oneline && (!subject || oneline[2].trim() === subject) ? oneline[1] : "");
  const finalSubject = subject || bracket?.[2]?.trim() || "";
  if (!sha || !finalSubject) return null;
  return { sha: sha.toLowerCase(), message: finalSubject.slice(0, 300) };
}

const EDIT_TOOLS = /^(?:Edit|Write|MultiEdit|NotebookEdit|edit|write|patch|apply_patch)$/;

/** One finished tool call (name, input, output) → events. Shared by the
 * Claude Code and OpenCode parsers. */
export function toolCallEvents(ref: string, name: string, input: Record<string, any>, output: string, opts: { isError?: boolean; exitCode?: number | null } = {}): EventDraft[] {
  if (!ref) return [];
  const out: EventDraft[] = [];
  if (EDIT_TOOLS.test(name)) {
    const p = String(input.file_path ?? input.filePath ?? input.notebook_path ?? input.path ?? "");
    if (p && !opts.isError) out.push({ type: "file_edit", sourceRef: ref, payload: { path: p, code: isCodeFile(p) } });
    return out;
  }
  if (!/^(?:Bash|bash|shell|exec_command)$/.test(name)) return out;
  const command = String(input.command ?? input.cmd ?? "");
  const commit = commitFrom(command, output);
  if (commit && !opts.isError) out.push({ type: "commit", sourceRef: `${ref}:commit`, payload: { ...commit } });
  const verifier = verifierName(command);
  if (verifier) {
    const r = runFailed(output, opts.exitCode, opts.isError);
    out.push({
      type: "command",
      sourceRef: ref,
      payload: { verifier, command: command.replace(/\s+/g, " ").trim().slice(0, 300), failed: r.failed, errorLine: r.errorLine },
    });
  }
  return out;
}

/** Claude Code `ai-title` / `custom-title` lines. */
export function claudeTitleEvent(line: Record<string, unknown>): EventDraft | null {
  const custom = line.type === "custom-title";
  if (line.type !== "ai-title" && !custom) return null;
  const title = String((custom ? line.customTitle : line.aiTitle) ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return title ? { type: "title", sourceRef: `title:${custom ? "custom" : "ai"}:${title}`, payload: { title, source: custom ? "custom" : "ai" } } : null;
}
