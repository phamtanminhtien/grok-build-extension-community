/**
 * In-webview permission + ask-user-question payloads (TUI-aligned popovers).
 */

export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: string;
  label: string;
}

export interface PermissionPromptPayload {
  promptId: number;
  title: string;
  detail: string;
  options: PermissionOptionView[];
  timeoutMs: number;
}

export type PermissionPromptResult =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" }
  | { outcome: "timeout" };

export interface QuestionOptionView {
  label: string;
  description: string;
  preview?: string;
  id?: string;
}

export interface QuestionView {
  question: string;
  options: QuestionOptionView[];
  multiSelect: boolean;
  id?: string;
}

export interface QuestionPromptPayload {
  promptId: number;
  toolCallId: string;
  mode: "default" | "plan";
  questions: QuestionView[];
  /** Soft UX timeout; agent may have a longer tool timeout. */
  timeoutMs: number;
}

/** Wire response for `x.ai/ask_user_question` (snake_case outcome tag). */
export type AskUserQuestionResponse =
  | {
      outcome: "accepted";
      answers: Record<string, string[]>;
      annotations?: Record<
        string,
        { preview?: string; notes?: string }
      >;
    }
  | {
      outcome: "chat_about_this";
      partial_answers: Record<string, string>;
    }
  | {
      outcome: "skip_interview";
      partial_answers: Record<string, string>;
    }
  | { outcome: "cancelled" };

export interface AskUserQuestionRequest {
  sessionId?: string;
  session_id?: string;
  toolCallId?: string;
  tool_call_id?: string;
  questions?: unknown[];
  mode?: string;
}

export function parseAskUserQuestionRequest(
  raw: unknown,
): {
  sessionId: string;
  toolCallId: string;
  mode: "default" | "plan";
  questions: QuestionView[];
} | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const o = raw as AskUserQuestionRequest;
  const sessionId = String(o.sessionId ?? o.session_id ?? "");
  const toolCallId = String(o.toolCallId ?? o.tool_call_id ?? "");
  const modeRaw = String(o.mode ?? "default").toLowerCase();
  const mode: "default" | "plan" = modeRaw === "plan" ? "plan" : "default";
  const questions = Array.isArray(o.questions)
    ? o.questions.map(parseQuestion).filter((q): q is QuestionView => !!q)
    : [];
  if (questions.length === 0) {
    return null;
  }
  return { sessionId, toolCallId, mode, questions };
}

function parseQuestion(raw: unknown): QuestionView | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const q = raw as Record<string, unknown>;
  const question = String(q.question ?? "").trim();
  if (!question) {
    return null;
  }
  const multiSelect = !!(q.multiSelect ?? q.multi_select);
  const optionsRaw = Array.isArray(q.options) ? q.options : [];
  const options: QuestionOptionView[] = [];
  for (const opt of optionsRaw) {
    if (!opt || typeof opt !== "object") {
      continue;
    }
    const o = opt as Record<string, unknown>;
    const label = String(o.label ?? "").trim();
    if (!label) {
      continue;
    }
    const previewRaw =
      o.preview != null && String(o.preview).trim()
        ? String(o.preview)
        : undefined;
    const option: QuestionOptionView = {
      label,
      description: String(o.description ?? ""),
    };
    if (previewRaw !== undefined) {
      option.preview = previewRaw;
    }
    if (o.id != null) {
      option.id = String(o.id);
    }
    options.push(option);
  }
  return {
    question,
    options,
    multiSelect,
    id: q.id != null ? String(q.id) : undefined,
  };
}

export function permissionOptionLabel(kind: string, name: string): string {
  switch (kind) {
    case "allow_once":
      return name || "Allow once";
    case "allow_always":
      return name || "Always allow (session)";
    case "reject_once":
      return name || "Deny";
    case "reject_always":
      return name || "Always deny";
    default:
      return name || kind;
  }
}

export function permissionOptionIcon(kind: string): string {
  switch (kind) {
    case "allow_once":
      return "ti-check";
    case "allow_always":
      return "ti-checks";
    case "reject_once":
      return "ti-x";
    case "reject_always":
      return "ti-ban";
    default:
      return "ti-circle-dot";
  }
}
