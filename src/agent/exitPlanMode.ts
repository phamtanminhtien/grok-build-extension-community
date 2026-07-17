/**
 * Wire types for reverse-request `x.ai/exit_plan_mode`
 * (xai-grok-tools exit_plan_mode::types).
 */

export interface ExitPlanModeRequest {
  sessionId: string;
  toolCallId: string;
  planContent?: string;
}

/** Response outcomes expected by the shell coordinator. */
export type ExitPlanModeOutcome = "approved" | "cancelled" | "abandoned";

export interface ExitPlanModeResponse {
  outcome: ExitPlanModeOutcome;
  feedback?: string;
}

export interface ExitPlanModePromptPayload {
  promptId: number;
  sessionId: string;
  toolCallId: string;
  planContent: string;
  hasPlan: boolean;
  timeoutMs: number;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Unwrap ExtRequest nesting then parse ExitPlanModeExtRequest (camelCase).
 */
export function parseExitPlanModeRequest(
  raw: unknown,
): ExitPlanModeRequest | null {
  let cur: unknown = raw;
  for (let i = 0; i < 3; i++) {
    const o = asRecord(cur);
    if (!o) {
      break;
    }
    if (
      o.params != null &&
      o.sessionId == null &&
      o.session_id == null &&
      o.toolCallId == null &&
      o.tool_call_id == null
    ) {
      cur = o.params;
      continue;
    }
    break;
  }
  const o = asRecord(cur);
  if (!o) {
    return null;
  }
  const sessionId = asString(o.sessionId ?? o.session_id)?.trim() ?? "";
  const toolCallId = asString(o.toolCallId ?? o.tool_call_id)?.trim() ?? "";
  if (!sessionId || !toolCallId) {
    return null;
  }
  const planRaw = o.planContent ?? o.plan_content;
  const planContent =
    typeof planRaw === "string" && planRaw.trim() ? planRaw : undefined;
  return { sessionId, toolCallId, planContent };
}

export function exitPlanModeResponse(
  outcome: ExitPlanModeOutcome,
  feedback?: string,
): ExitPlanModeResponse {
  const fb = feedback?.trim();
  if (outcome === "cancelled" && fb) {
    return { outcome, feedback: fb };
  }
  return { outcome };
}
