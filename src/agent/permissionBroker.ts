import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOption,
} from "@agentclientprotocol/sdk";
import * as vscode from "vscode";
import { getSettings } from "../config/settings";
import { logInfo, logWarn } from "../log/output";

/**
 * Resolve ACP permission requests via QuickPick + optional session memory.
 */
export class PermissionBroker {
  /** optionIds auto-selected for allow_always this process/session */
  private alwaysAllowOptionIds = new Set<string>();
  private alwaysReject = false;
  private queue: Promise<void> = Promise.resolve();

  resetSessionMemory(): void {
    this.alwaysAllowOptionIds.clear();
    this.alwaysReject = false;
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
    const settings = getSettings();
    const options = params.options ?? [];
    const title =
      params.toolCall?.title ??
      params.toolCall?.toolCallId ??
      "tool operation";

    logInfo(`[permission] request: ${title}`);

    if (settings.alwaysApprove) {
      const allow =
        options.find((o) => o.kind === "allow_always") ??
        options.find((o) => o.kind === "allow_once");
      if (allow) {
        logInfo(`[permission] alwaysApprove setting → ${allow.kind}`);
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
    const picks = options.map((o) => ({
      label: labelFor(o),
      description: o.kind,
      option: o,
    }));

    const timeoutMs = settings.permissionTimeoutMs;
    const pickPromise = vscode.window.showQuickPick(picks, {
      title: `Grok Build wants to: ${title}`,
      placeHolder: detail.slice(0, 200) || "Choose allow or deny",
      ignoreFocusOut: true,
    });

    const timedOut = Symbol("timeout");
    const result = await Promise.race([
      pickPromise,
      new Promise<typeof timedOut>((resolve) => {
        setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);

    if (result === timedOut) {
      logWarn(`[permission] timed out after ${timeoutMs}ms → deny`);
      void vscode.window.showWarningMessage(
        "Grok Build: permission timed out — denied",
      );
      // Dismiss QuickPick by returning deny; user may still have dialog open
      return denyResponse(options);
    }

    if (!result) {
      logWarn("[permission] dismissed → deny");
      return denyResponse(options);
    }

    const opt = result.option as PermissionOption;
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

function labelFor(o: PermissionOption): string {
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
