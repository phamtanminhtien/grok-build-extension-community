/**
 * Slash command types — aligned with grok-build pager `SlashCommand` + ACP
 * `AvailableCommand`.
 */

/** How the VS Code host dispatches a command. */
export type CommandLayer =
  /** Extension handles locally (IDE action). */
  | "host"
  /** Send `/{name} args` as session/prompt — shell/agent resolves. */
  | "passthrough"
  /** TUI-only; show a message, do not send. */
  | "unsupported";

export type CommandSource = "host" | "acp";

export interface SlashCommandDef {
  /** Canonical name without leading `/`. */
  name: string;
  aliases: string[];
  description: string;
  takesArgs: boolean;
  argsRequired: boolean;
  /** Placeholder for args (e.g. `<name>`). */
  argHint?: string;
  layer: CommandLayer;
  /** Stable host action id when `layer === "host"`. */
  hostAction?: HostAction;
  source: CommandSource;
}

/**
 * Host-side actions mapped from pager builtins that the extension can run.
 */
export type HostAction =
  | "newSession"
  | "resumeSession"
  | "selectModel"
  | "setModel"
  | "login"
  | "logout"
  | "help"
  | "docs"
  | "settings"
  | "alwaysApprove"
  | "export"
  | "copy"
  | "context"
  | "sessionInfo"
  | "cd"
  | "home"
  | "quit"
  | "openOutput"
  | "cancel"
  | "reviewEdits"
  | "startAgent"
  | "restartAgent"
  /** Open Grok Extensions panel; optional tab via slash name mapping. */
  | "openExtensions";

/** Row shown in the slash dropdown. */
export interface SlashSuggestion {
  name: string;
  display: string;
  description: string;
  insertText: string;
  takesArgs: boolean;
  argsRequired: boolean;
  source: CommandSource;
  layer: CommandLayer;
}

/** Parsed `/cmd args` from a send line. */
export interface SlashInvocation {
  /** Raw line. */
  raw: string;
  /** Command key as typed (may be alias). */
  key: string;
  /** Resolved canonical name if known. */
  name: string;
  args: string;
  command?: SlashCommandDef;
}

/** Cursor is inside a leading slash command token. */
export interface SlashContext {
  /** Full command token range including leading `/`. */
  range: { start: number; end: number };
  cursor: number;
  /** Text after `/` up to cursor (query for fuzzy match). */
  query: string;
  /** True when cursor is still in the command name (not args). */
  inCommand: boolean;
  /** Args text after the command token (may be empty). */
  args: string;
}
