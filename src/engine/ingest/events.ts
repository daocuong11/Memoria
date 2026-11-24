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
  type: "todo_list" | "question" | "title";
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

/** Claude Code `ai-title` / `custom-title` lines. */
export function claudeTitleEvent(line: Record<string, unknown>): EventDraft | null {
  const custom = line.type === "custom-title";
  if (line.type !== "ai-title" && !custom) return null;
  const title = String((custom ? line.customTitle : line.aiTitle) ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  return title ? { type: "title", sourceRef: `title:${custom ? "custom" : "ai"}:${title}`, payload: { title, source: custom ? "custom" : "ai" } } : null;
}
