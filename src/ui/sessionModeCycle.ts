/**
 * Shift+Tab mode cycle — aligned with TUI (`dispatch_cycle_mode_inner`).
 *
 * Ring (auto feature on, default):
 *   Normal → Plan → Auto → Always-Approve → Normal
 *
 * Semantics (TUI):
 * - **Normal / agent**: ask for tool permission (default session mode).
 * - **Plan**: ACP `session/set_mode` → `plan` (agent plans only; edits gated).
 * - **Auto**: LLM classifier approves safe tools (`permission_mode: auto`).
 *   Not the same as always-approve.
 * - **Always-Approve** (aka YOLO internally): auto-run *all* tool actions
 *   without prompts (`yolo_mode: true`). TUI prompt flag text is
 *   `always-approve`, never "YOLO".
 *
 * Wire to agent:
 * - Plan: `session/set_mode` plan/default
 * - Permission arms: client notification `x.ai/yolo_mode_changed`
 *   `{ yolo_mode, auto_mode, permission_mode }`
 */

export type CycleModeId = "normal" | "plan" | "auto" | "always-approve";

/** Ring order matching TUI Shift+Tab with auto_mode_gate ON. */
export const CYCLE_ORDER: readonly CycleModeId[] = [
  "normal",
  "plan",
  "auto",
  "always-approve",
] as const;

export function cycleMode(current: CycleModeId): CycleModeId {
  const i = CYCLE_ORDER.indexOf(current);
  const idx = i < 0 ? 0 : (i + 1) % CYCLE_ORDER.length;
  return CYCLE_ORDER[idx]!;
}

/**
 * Display label for button + mode-switch banner.
 * Matches TUI cycle control labels: Normal · Plan · Auto · Always Approve.
 * (Prompt info-line flags stay lowercase on TUI; the cycle control uses these.)
 */
export function modeLabel(mode: CycleModeId): string {
  switch (mode) {
    case "normal":
      return "Normal";
    case "plan":
      return "Plan";
    case "auto":
      return "Auto";
    case "always-approve":
      return "Always Approve";
  }
}

/** Composer button label — same as {@link modeLabel}. */
export function modeButtonLabel(mode: CycleModeId): string {
  return modeLabel(mode);
}

/** Short description for tooltips. */
export function modeDescription(mode: CycleModeId): string {
  switch (mode) {
    case "normal":
      return "Ask before running tools";
    case "plan":
      return "Plan mode — research and write plan.md only";
    case "auto":
      return "Auto — classifier approves safe tools";
    case "always-approve":
      return "Always Approve — all tool actions auto-run";
  }
}

/** ACP `session/set_mode` id for this cycle arm. */
export function modeToAcpModeId(mode: CycleModeId): string {
  return mode === "plan" ? "plan" : "default";
}

/** Canonical `permission_mode` for `x.ai/yolo_mode_changed`. */
export function modeToPermissionCanonical(mode: CycleModeId): string {
  switch (mode) {
    case "always-approve":
      return "always-approve";
    case "auto":
      return "auto";
    case "plan":
    case "normal":
      return "ask";
  }
}

export function modeWantsYolo(mode: CycleModeId): boolean {
  return mode === "always-approve";
}

export function modeWantsAuto(mode: CycleModeId): boolean {
  return mode === "auto";
}

/** @deprecated use modeWantsYolo */
export function modeWantsAlwaysApprove(mode: CycleModeId): boolean {
  return modeWantsYolo(mode);
}

/**
 * Map agent-confirmed session mode + permission flags into the cycle ring.
 * Precedence: plan > yolo (always-approve) > auto > normal (TUI flag order).
 */
export function cycleModeFromAgent(
  acpModeId: string | undefined | null,
  opts: { yolo?: boolean; auto?: boolean } | boolean = {},
): CycleModeId {
  // Back-compat: second arg was `alwaysApprove: boolean`.
  const flags =
    typeof opts === "boolean" ? { yolo: opts, auto: false } : opts;
  const id = (acpModeId ?? "default").trim().toLowerCase();
  if (id === "plan") {
    return "plan";
  }
  if (flags.yolo) {
    return "always-approve";
  }
  if (flags.auto) {
    return "auto";
  }
  return "normal";
}

/** CSS modifier for the mode button. */
export function modeCssClass(mode: CycleModeId): string {
  switch (mode) {
    case "normal":
      return "mode-normal";
    case "plan":
      return "mode-plan";
    case "auto":
      return "mode-auto";
    case "always-approve":
      return "mode-always-approve";
  }
}

/** Toast text when entering a mode (TUI-aligned). */
export function modeToast(mode: CycleModeId): string {
  switch (mode) {
    case "normal":
      return "Mode: Normal";
    case "plan":
      return "Mode: Plan";
    case "auto":
      return "✓ Permission mode: Auto (classifier)";
    case "always-approve":
      return "⚠ Always Approve ON: all tool actions auto-run";
  }
}
