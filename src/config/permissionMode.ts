/**
 * Permission mode — shared with the Grok CLI / TUI via
 * `~/.grok/config.toml` `[ui].permission_mode`.
 *
 * Matches shell `load_permission_mode` / `PersistPermissionMode`:
 *   permission_mode = "always-approve" | "auto" | "ask" | "default"
 *   approval_mode   = "always-approve"  (legacy)
 *   yolo            = true|false        (legacy)
 *
 * Precedence when any key is present: permission_mode > approval_mode > yolo.
 * Missing keys → ask. Unknown strings → ask (safe).
 */

import type { CycleModeId } from "../ui/sessionModeCycle";
import {
  extractTomlSection,
  grokConfigPath,
  matchBoolKey,
  matchStringKey,
  readGrokConfigText,
  upsertTomlSectionString,
  writeGrokConfigText,
} from "./tomlConfig.ts";

export { extractTomlSection, grokConfigPath };

/** Disk / ACP canonical strings (TUI contract). */
export type PermissionModeCanonical =
  | "always-approve"
  | "auto"
  | "ask"
  | "default";

/** Resolved runtime mode (default collapses to ask). */
export type PermissionModeResolved = "always-approve" | "auto" | "ask";

/**
 * Parse a canonical string. Unknown → ask.
 */
export function parsePermissionModeCanonical(
  modeStr: string,
): PermissionModeResolved {
  switch (modeStr.trim().toLowerCase()) {
    case "always-approve":
    case "bypasspermissions":
      return "always-approve";
    case "auto":
      return "auto";
    case "ask":
    case "default":
      return "ask";
    default:
      return "ask";
  }
}

function sectionHasPermissionKey(section: string): boolean {
  return (
    /^\s*permission_mode\s*=/m.test(section) ||
    /^\s*approval_mode\s*=/m.test(section) ||
    /^\s*yolo\s*=/m.test(section)
  );
}

/**
 * Resolve permission mode from a full config.toml body (TUI rules).
 * Pure — for tests and callers that already have the file text.
 */
export function resolvePermissionModeFromToml(
  text: string,
): PermissionModeResolved {
  const ui = extractTomlSection(text, "ui");
  if (ui == null || !sectionHasPermissionKey(ui)) {
    return "ask";
  }

  const permissionMode = matchStringKey(ui, "permission_mode");
  if (permissionMode != null) {
    return parsePermissionModeCanonical(permissionMode);
  }

  const approvalMode = matchStringKey(ui, "approval_mode");
  if (approvalMode != null) {
    return approvalMode.trim().toLowerCase() === "always-approve"
      ? "always-approve"
      : "ask";
  }

  if (matchBoolKey(ui, "yolo") === true) {
    return "always-approve";
  }

  return "ask";
}

/**
 * Load from `~/.grok/config.toml`. Missing/unreadable → ask.
 */
export function loadPermissionMode(
  configPath: string = grokConfigPath(),
): PermissionModeResolved {
  return resolvePermissionModeFromToml(readGrokConfigText(configPath));
}

export function isAlwaysApproveMode(
  mode: PermissionModeResolved = loadPermissionMode(),
): boolean {
  return mode === "always-approve";
}

export function isAutoMode(
  mode: PermissionModeResolved = loadPermissionMode(),
): boolean {
  return mode === "auto";
}

/** Map resolved disk mode → Shift+Tab cycle arm (not plan). */
export function permissionModeToCycleMode(
  mode: PermissionModeResolved,
): Exclude<CycleModeId, "plan"> {
  switch (mode) {
    case "always-approve":
      return "always-approve";
    case "auto":
      return "auto";
    case "ask":
      return "normal";
  }
}

/**
 * Map cycle arm → disk canonical string.
 * Plan is session-only and must not be written to `permission_mode`.
 */
export function cycleModeToPermissionCanonical(
  mode: CycleModeId,
): PermissionModeCanonical | undefined {
  switch (mode) {
    case "always-approve":
      return "always-approve";
    case "auto":
      return "auto";
    case "normal":
      return "ask";
    case "plan":
      return undefined;
  }
}

/**
 * Drop obsolete legacy keys once `permission_mode` is the canonical store.
 * Keeps comments/other keys; only removes bare `yolo` / `approval_mode` lines.
 */
export function stripLegacyPermissionKeys(text: string): string {
  return text
    .replace(/^\s*yolo\s*=\s*(true|false)\s*(?:#.*)?\r?\n/gim, "")
    .replace(
      /^\s*approval_mode\s*=\s*(?:"[^"]*"|'[^']*'|[^\s#\r\n]+)\s*(?:#.*)?\r?\n/gim,
      "",
    );
}

/**
 * Upsert `[ui].permission_mode = "…"` in a config.toml body.
 * Preserves other content; creates `[ui]` when missing.
 * Also strips legacy `yolo` / `approval_mode` so disk matches TUI canonical form.
 */
export function upsertPermissionModeInToml(
  text: string,
  mode: PermissionModeCanonical,
): string {
  const body = stripLegacyPermissionKeys(text);
  return upsertTomlSectionString(body, "ui", "permission_mode", mode);
}

/**
 * Persist permission mode to disk (TUI `PersistPermissionMode`).
 * Ensures `~/.grok` exists. Returns the written canonical string.
 */
export function persistPermissionMode(
  mode: PermissionModeCanonical,
  configPath: string = grokConfigPath(),
): PermissionModeCanonical {
  const existing = readGrokConfigText(configPath);
  const next = upsertPermissionModeInToml(existing, mode);
  writeGrokConfigText(next, configPath);
  return mode;
}

/**
 * Persist from a cycle mode arm. No-op for plan (session-only).
 * Returns the canonical string written, or undefined if skipped.
 */
export function persistPermissionModeFromCycle(
  mode: CycleModeId,
  configPath: string = grokConfigPath(),
): PermissionModeCanonical | undefined {
  const canonical = cycleModeToPermissionCanonical(mode);
  if (!canonical) {
    return undefined;
  }
  return persistPermissionMode(canonical, configPath);
}
