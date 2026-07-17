/**
 * Full slash catalog from grok-build pager builtins (+ shell-only names).
 * Order ≈ pager `builtin_commands()` display order.
 *
 * layer:
 *  - host: VS Code extension executes
 *  - passthrough: send as prompt for agent/shell
 *  - unsupported: TUI-only surface
 */

import type { HostAction, SlashCommandDef } from "./types";

type Def = Omit<
  SlashCommandDef,
  "source" | "aliases" | "takesArgs" | "argsRequired"
> & {
  aliases?: string[];
  takesArgs?: boolean;
  argsRequired?: boolean;
  hostAction?: HostAction;
};

function d(partial: Def): SlashCommandDef {
  return {
    aliases: partial.aliases ?? [],
    takesArgs: partial.takesArgs ?? false,
    argsRequired: partial.argsRequired ?? false,
    source: "host",
    ...partial,
  };
}

/**
 * Pager + shell command catalog. Host wins on name collision with ACP.
 */
export const HOST_COMMANDS: SlashCommandDef[] = [
  // ── Session ──────────────────────────────────────────────
  d({
    name: "new",
    aliases: ["clear"],
    description: "Start a new session",
    layer: "host",
    hostAction: "newSession",
  }),
  d({
    name: "resume",
    description: "Resume a previous session",
    layer: "host",
    hostAction: "resumeSession",
  }),
  d({
    name: "history",
    description: "Search prompt history / open session list",
    layer: "host",
    hostAction: "resumeSession",
  }),
  d({
    name: "home",
    aliases: ["welcome"],
    description: "Return to the welcome screen",
    layer: "host",
    hostAction: "home",
  }),
  d({
    name: "quit",
    aliases: ["exit"],
    description: "Stop the agent / quit the session",
    layer: "host",
    hostAction: "quit",
  }),
  d({
    name: "fork",
    description: "Branch the current session into a peer agent",
    takesArgs: true,
    argHint: "[--worktree|--no-worktree] [directive]",
    layer: "host",
    hostAction: "fork",
  }),
  d({
    name: "compact",
    description: "Compact conversation history",
    takesArgs: true,
    argHint: "optional context to preserve",
    layer: "host",
    hostAction: "compact",
  }),
  d({
    name: "copy",
    description: "Copy last response to clipboard (/copy N for Nth-latest)",
    takesArgs: true,
    argHint: "[N]",
    layer: "host",
    hostAction: "copy",
  }),
  d({
    name: "find",
    description: "Search the conversation scrollback",
    takesArgs: true,
    argHint: "[text]",
    layer: "unsupported",
  }),
  d({
    name: "export",
    description: "Export the current conversation to a file or clipboard",
    takesArgs: true,
    argHint: "[filename]",
    layer: "host",
    hostAction: "export",
  }),
  d({
    name: "transcript",
    aliases: ["log"],
    description: "View the full conversation transcript",
    layer: "host",
    hostAction: "export",
  }),
  d({
    name: "expand",
    description:
      "Re-print the last collapsed block, fully expanded (minimal mode)",
    layer: "unsupported",
  }),
  d({
    name: "context",
    description: "View context usage and session stats",
    layer: "host",
    hostAction: "context",
  }),
  d({
    name: "session-info",
    description: "Show session info",
    layer: "host",
    hostAction: "sessionInfo",
  }),
  d({
    name: "rename",
    aliases: ["title"],
    description: "Rename the current session",
    takesArgs: true,
    argsRequired: true,
    argHint: "<title>",
    layer: "host",
    hostAction: "rename",
  }),
  d({
    name: "rewind",
    description: "Rewind to a previous turn",
    layer: "passthrough",
  }),
  d({
    name: "jump",
    description: "Jump to a turn in the conversation",
    layer: "unsupported",
  }),
  d({
    name: "share",
    description: "Share this session via URL",
    layer: "passthrough",
  }),
  d({
    name: "recap",
    description: "Summarize the session so far",
    layer: "passthrough",
  }),

  // ── Model / mode ─────────────────────────────────────────
  d({
    name: "model",
    aliases: ["m"],
    description: "Switch the active model",
    takesArgs: true,
    argsRequired: true,
    argHint: "<name> [effort]",
    layer: "host",
    hostAction: "selectModel",
  }),
  d({
    name: "effort",
    description: "Set reasoning effort for the current model",
    takesArgs: true,
    argsRequired: true,
    argHint: "<level>",
    layer: "passthrough",
  }),
  d({
    name: "always-approve",
    aliases: ["yolo"],
    description: "Toggle always-approve mode (skip all permission prompts)",
    takesArgs: true,
    argHint: "on|off",
    layer: "host",
    hostAction: "alwaysApprove",
  }),
  d({
    name: "auto",
    description: "Toggle auto mode (classifier approves safe tools)",
    layer: "passthrough",
  }),
  d({
    name: "plan",
    description: "Enter plan mode",
    takesArgs: true,
    argHint: "[description]",
    layer: "passthrough",
  }),
  d({
    name: "view-plan",
    aliases: ["show-plan", "plan-view"],
    description: "View the current plan",
    layer: "passthrough",
  }),

  // ── Help / docs / settings ───────────────────────────────
  d({
    name: "help",
    description: "Browse commands and keyboard shortcuts",
    layer: "host",
    hostAction: "help",
  }),
  d({
    name: "docs",
    aliases: ["howto", "guides"],
    description: "Open How-to Guides or online Build docs",
    takesArgs: true,
    argHint: "[web|title]",
    layer: "host",
    hostAction: "docs",
  }),
  d({
    name: "settings",
    aliases: ["config", "preferences", "prefs"],
    description: "Open the settings modal",
    layer: "host",
    hostAction: "settings",
  }),
  d({
    name: "login",
    description: "Sign in with browser (OAuth) or set an API key",
    layer: "host",
    hostAction: "login",
  }),
  d({
    name: "logout",
    description: "Log out (clear Grok session + SecretStorage API key)",
    layer: "host",
    hostAction: "logout",
  }),
  d({
    name: "output",
    description: "Open the Grok Build output channel",
    layer: "host",
    hostAction: "openOutput",
  }),
  d({
    name: "cancel",
    aliases: ["stop"],
    description: "Cancel the current turn",
    layer: "host",
    hostAction: "cancel",
  }),
  d({
    name: "review",
    description: "Review pending file edits",
    layer: "host",
    hostAction: "reviewEdits",
  }),
  d({
    name: "start",
    description: "Start the Grok agent process",
    layer: "host",
    hostAction: "startAgent",
  }),
  d({
    name: "restart",
    description: "Restart the Grok agent process",
    layer: "host",
    hostAction: "restartAgent",
  }),

  // ── Workspace ────────────────────────────────────────────
  d({
    name: "cd",
    description: "Change the working directory for new agents",
    takesArgs: true,
    argHint: "[path]",
    layer: "host",
    hostAction: "cd",
  }),

  // ── Memory / shell builtins ──────────────────────────────
  d({
    name: "flush",
    description: "Flush conversation memory to disk now",
    layer: "passthrough",
  }),
  d({
    name: "dream",
    description: "Run memory consolidation (merge session logs into topics)",
    layer: "passthrough",
  }),
  d({
    name: "memory",
    aliases: ["mem"],
    description: "Browse, view, and manage your memories",
    takesArgs: true,
    argHint: "on|off",
    layer: "passthrough",
  }),
  d({
    name: "remember",
    description: "Save a memory note",
    takesArgs: true,
    argHint: "[text]",
    layer: "passthrough",
  }),
  d({
    name: "loop",
    description: "Run a prompt on a recurring interval",
    takesArgs: true,
    argsRequired: true,
    argHint: "[interval] <prompt>",
    layer: "passthrough",
  }),
  d({
    name: "goal",
    description: "Set, manage, or check an autonomous goal",
    takesArgs: true,
    argHint: "[description]",
    layer: "passthrough",
  }),
  d({
    name: "btw",
    description: "Ask a side question without interrupting",
    takesArgs: true,
    argsRequired: true,
    argHint: "<question>",
    layer: "passthrough",
  }),

  // ── Plugins / hooks / skills (host: open Extensions panel) ─
  d({
    name: "hooks",
    description: "View hooks",
    layer: "host",
    hostAction: "openExtensions",
  }),
  d({
    name: "hooks-trust",
    description: "Trust this project for hook execution",
    layer: "passthrough",
  }),
  d({
    name: "hooks-list",
    description: "Show hooks loaded in this session",
    layer: "passthrough",
  }),
  d({
    name: "hooks-add",
    description: "Add a custom hook file or directory",
    takesArgs: true,
    argsRequired: true,
    argHint: "path",
    layer: "passthrough",
  }),
  d({
    name: "hooks-remove",
    description: "Remove a custom hook file or directory path",
    takesArgs: true,
    argsRequired: true,
    argHint: "path",
    layer: "passthrough",
  }),
  d({
    name: "hooks-untrust",
    description: "Remove trust for the current project",
    layer: "passthrough",
  }),
  d({
    name: "plugins",
    aliases: ["plugin"],
    description: "View plugins",
    layer: "host",
    hostAction: "openExtensions",
  }),
  d({
    name: "reload-plugins",
    description: "Reload plugins from disk",
    layer: "passthrough",
  }),
  d({
    name: "marketplace",
    description: "View marketplace",
    layer: "host",
    hostAction: "openExtensions",
  }),
  d({
    name: "skills",
    description: "View skills",
    layer: "host",
    hostAction: "openExtensions",
  }),
  d({
    name: "mcps",
    description: "Show MCP server status",
    layer: "host",
    hostAction: "openExtensions",
  }),
  d({
    name: "config-agents",
    aliases: ["agents"],
    description: "Manage agent definitions",
    layer: "passthrough",
  }),
  d({
    name: "personas",
    description: "Manage personas (create, edit, delete)",
    layer: "passthrough",
  }),

  // ── Media / tasks ────────────────────────────────────────
  d({
    name: "imagine",
    description: "Generate an image from a text description",
    takesArgs: true,
    argsRequired: true,
    argHint: "<description>",
    layer: "passthrough",
  }),
  d({
    name: "imagine-video",
    description: "Generate a video from a text description",
    takesArgs: true,
    argsRequired: true,
    argHint: "<description>",
    layer: "passthrough",
  }),
  d({
    name: "tasks",
    description: "List background tasks, subagents, and scheduled tasks",
    layer: "host",
    hostAction: "showTasks",
  }),
  d({
    name: "queue",
    description: "List the prompts queued behind the running turn",
    layer: "passthrough",
  }),
  d({
    name: "usage",
    aliases: ["cost"],
    description: "View credit usage or manage billing",
    takesArgs: true,
    argHint: "[show|manage]",
    layer: "passthrough",
  }),
  d({
    name: "feedback",
    description: "Send feedback about the current session",
    takesArgs: true,
    argHint: "[text]",
    layer: "passthrough",
  }),
  d({
    name: "privacy",
    description: "Show or toggle privacy & data retention status",
    takesArgs: true,
    argHint: "[opt-in|opt-out]",
    layer: "passthrough",
  }),
  d({
    name: "release-notes",
    aliases: ["changelog"],
    description: "View release notes for the current version",
    layer: "passthrough",
  }),
  d({
    name: "import-claude",
    description: "Open the Claude settings import modal",
    layer: "passthrough",
  }),
  d({
    name: "announcements",
    description: "Show or hide announcements",
    takesArgs: true,
    argsRequired: true,
    argHint: "hide | show",
    layer: "passthrough",
  }),

  // ── TUI-only UI ──────────────────────────────────────────
  d({
    name: "dashboard",
    aliases: ["agents-dashboard", "sessions"],
    description: "Open the Agent Dashboard (TUI)",
    layer: "unsupported",
  }),
  d({
    name: "theme",
    aliases: ["t"],
    description: "Switch the color theme",
    takesArgs: true,
    argHint: "<name>",
    layer: "unsupported",
  }),
  d({
    name: "multiline",
    aliases: ["ml"],
    description: "Toggle multiline input mode (swap Enter and Shift+Enter)",
    layer: "unsupported",
  }),
  d({
    name: "compact-mode",
    description: "Toggle compact UI (less padding, more content)",
    layer: "unsupported",
  }),
  d({
    name: "vim-mode",
    description: "Toggle vim-style scrollback keybindings",
    layer: "unsupported",
  }),
  d({
    name: "minimal",
    description: "Reopen this session in minimal (scrollback-native) mode",
    layer: "unsupported",
  }),
  d({
    name: "fullscreen",
    aliases: ["full"],
    description: "Reopen this session in fullscreen mode",
    layer: "unsupported",
  }),
  d({
    name: "timeline",
    description: "Toggle the timeline sidebar",
    layer: "unsupported",
  }),
  d({
    name: "timestamps",
    description: "Toggle message timestamps on/off",
    layer: "unsupported",
  }),
  d({
    name: "toggle-mouse-reporting",
    description: "Toggle terminal mouse reporting",
    layer: "unsupported",
  }),
  d({
    name: "terminal-setup",
    aliases: ["terminal-check", "terminal-info"],
    description: "Check terminal, color, and clipboard setup",
    layer: "unsupported",
  }),
  d({
    name: "voice",
    description: "Dictation (TUI only)",
    layer: "unsupported",
  }),
  d({
    name: "scroll-debug",
    description: "Toggle the scroll-diagnostics HUD",
    layer: "unsupported",
  }),
  d({
    name: "debug",
    description: "Toggle debug overlays",
    takesArgs: true,
    argHint: "[scroll|fps|log]",
    layer: "unsupported",
  }),
  d({
    name: "gboom",
    description: "Hidden easter egg",
    layer: "passthrough",
  }),
];

export function hostCommandsByKey(): Map<string, SlashCommandDef> {
  const map = new Map<string, SlashCommandDef>();
  for (const cmd of HOST_COMMANDS) {
    map.set(cmd.name.toLowerCase(), cmd);
    for (const a of cmd.aliases) {
      map.set(a.toLowerCase(), cmd);
    }
  }
  return map;
}
