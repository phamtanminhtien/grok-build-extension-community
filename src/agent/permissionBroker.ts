import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { logInfo, logWarn } from "../log/output";
import {
  permissionOptionLabel,
  type PermissionOptionView,
  type PermissionPromptPayload,
  type PermissionPromptResult,
} from "../ui/interactivePrompt";

/** In-webview permission UI (TUI-style popover). */
export type PermissionPromptHandler = (
  payload: PermissionPromptPayload,
) => Promise<PermissionPromptResult>;

/**
 * Resolve ACP permission requests via in-webview popover + optional session memory.
 * Falls back to QuickPick when no webview handler is registered or ready.
 */
export class PermissionBroker {
  /** optionIds auto-selected for allow_always this process/session */
  private alwaysAllowOptionIds = new Set<string>();
  private alwaysReject = false;
  private queue: Promise<void> = Promise.resolve();
  /**
   * Session-scoped always-approve from Shift+Tab mode cycle (TUI yolo).
   * When set, overrides `grok.alwaysApprove` for this process session.
   * `undefined` → fall back to settings.
   */
  private alwaysApproveOverride: boolean | undefined;
  private promptUi: PermissionPromptHandler | undefined;
  private nextPromptId = 1;

  setPromptUi(handler: PermissionPromptHandler | undefined): void {
    this.promptUi = handler;
  }

  resetSessionMemory(): void {
    this.alwaysAllowOptionIds.clear();
    this.alwaysReject = false;
    // Keep override across new-session within same process — cycle is UI-owned.
    // Caller may clear via setAlwaysApproveOverride when resetting modes.
  }

  /**
   * Runtime always-approve (Shift+Tab Always-Approve arm). Pass `undefined`
   * to use only the VS Code setting.
   */
  setAlwaysApproveOverride(enabled: boolean | undefined): void {
    this.alwaysApproveOverride = enabled;
  }

  /** Effective always-approve: session override, else settings. */
  isAlwaysApprove(): boolean {
    if (this.alwaysApproveOverride !== undefined) {
      return this.alwaysApproveOverride;
    }
    return getSettings().alwaysApprove;
  }

  handle(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // Serialize permission dialogs
    const run = this.queue.then(() => this.handleOne(params));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async handleOne(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const options = params.options ?? [];
    const title =
      params.toolCall?.title ??
      params.toolCall?.toolCallId ??
      "tool operation";

    logInfo(`[permission] request: ${title}`);

    if (this.isAlwaysApprove()) {
      const allow =
        options.find((o) => o.kind === "allow_always") ??
        options.find((o) => o.kind === "allow_once");
      if (allow) {
        logInfo(`[permission] alwaysApprove → ${allow.kind}`);
        return selected(allow.optionId);
      }
    }

    if (this.alwaysReject) {
      return denyResponse(options);
    }

    for (const o of options) {
      if (o.kind === "allow_always" && this.alwaysAllowOptionIds.has(o.optionId)) {
        logInfo(`[permission] session always → ${o.name}`);
        return selected(o.optionId);
      }
    }
    // Also remember by kind allow_always generically
    const sessionAlways = options.find((o) => o.kind === "allow_always");
    if (sessionAlways && this.alwaysAllowOptionIds.has("*")) {
      return selected(sessionAlways.optionId);
    }

    const detail = summarizeTool(params);
    const viewOptions: PermissionOptionView[] = options.map((o) => {
      const optionId = String(
        (o as { optionId?: string; option_id?: string }).optionId ??
          (o as { option_id?: string }).option_id ??
          "",
      );
      return {
        optionId,
        name: o.name,
        kind: String(o.kind ?? ""),
        label: permissionOptionLabel(String(o.kind ?? ""), o.name),
      };
    }).filter((o) => !!o.optionId);
    const timeoutMs = getSettings().permissionTimeoutMs;
    const promptId = this.nextPromptId++;

    let result: PermissionPromptResult | undefined;
    if (this.promptUi) {
      try {
        result = await this.promptUi({
          promptId,
          title: String(title),
          detail,
          options: viewOptions,
          timeoutMs,
        });
      } catch (err) {
        logWarn(
          `[permission] webview prompt failed, falling back to QuickPick: ${err}`,
        );
        result = undefined;
      }
    }

    if (!result) {
      result = await this.quickPickFallback(
        String(title),
        detail,
        options,
        timeoutMs,
      );
    }

    if (result.outcome === "timeout") {
      logWarn(`[permission] timed out after ${timeoutMs}ms → deny`);
      void vscode.window.showWarningMessage(
        "Grok Build: permission timed out — denied",
      );
      return denyResponse(options);
    }

    if (result.outcome === "cancelled") {
      logWarn("[permission] dismissed → deny");
      return denyResponse(options);
    }

    const opt = options.find((o) => o.optionId === result.optionId);
    if (!opt) {
      logWarn("[permission] unknown optionId → deny");
      return denyResponse(options);
    }

    if (opt.kind === "allow_always") {
      this.alwaysAllowOptionIds.add(opt.optionId);
      this.alwaysAllowOptionIds.add("*");
    }
    if (opt.kind === "reject_always") {
      this.alwaysReject = true;
    }

    logInfo(`[permission] selected ${opt.kind} (${opt.name})`);
    return selected(opt.optionId);
  }

  private async quickPickFallback(
    title: string,
    detail: string,
    options: PermissionOption[],
    timeoutMs: number,
  ): Promise<PermissionPromptResult> {
    const picks = options.map((o) => ({
      label: quickPickLabel(o),
      description: o.kind,
      option: o,
    }));

    const pickPromise = vscode.window.showQuickPick(picks, {
      title: `Grok Build wants to: ${title}`,
      placeHolder: detail.slice(0, 200) || "Choose allow or deny",
      ignoreFocusOut: true,
    });

    const timedOut = Symbol("timeout");
    const race = await Promise.race([
      pickPromise,
      new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);

    if (race === timedOut) {
      return { outcome: "timeout" };
    }
    if (!race) {
      return { outcome: "cancelled" };
    }
    return {
      outcome: "selected",
      optionId: (race.option as PermissionOption).optionId,
    };
  }
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function denyResponse(options: PermissionOption[]): RequestPermissionResponse {
  const deny =
    options.find((o) => o.kind === "reject_once") ??
    options.find((o) => o.kind === "reject_always") ??
    options.find((o) => /deny|reject|cancel|no/i.test(o.name));
  if (deny) {
    return selected(deny.optionId);
  }
  return { outcome: { outcome: "cancelled" } };
}

function quickPickLabel(o: PermissionOption): string {
  switch (o.kind) {
    case "allow_once":
      return `$(check) ${o.name || "Allow once"}`;
    case "allow_always":
      return `$(pass-filled) ${o.name || "Always allow (session)"}`;
    case "reject_once":
      return `$(close) ${o.name || "Deny"}`;
    case "reject_always":
      return `$(circle-slash) ${o.name || "Always deny"}`;
    default:
      return o.name;
  }
}

function summarizeTool(params: RequestPermissionRequest): string {
  const tc = params.toolCall;
  if (!tc) {
    return "";
  }
  const parts: string[] = [];
  if (tc.kind) {
    parts.push(String(tc.kind));
  }
  if (tc.locations?.length) {
    parts.push(tc.locations.map((l) => l.path).join(", "));
  }
  try {
    if (tc.rawInput) {
      const s = JSON.stringify(tc.rawInput);
      parts.push(s.length > 180 ? s.slice(0, 180) + "…" : s);
    }
  } catch {
    /* ignore */
  }
  return parts.join(" · ");
}
