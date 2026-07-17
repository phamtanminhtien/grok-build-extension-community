const vscode = acquireVsCodeApi();
const messagesEl = document.getElementById("messages");
const emptyEl = document.getElementById("empty");
const emptyReady = document.getElementById("empty-ready");
const emptyCliMissing = document.getElementById("empty-cli-missing");
const emptyHint = document.getElementById("empty-hint");
const emptyGate = document.getElementById("empty-gate");
const emptyAuthBtn = document.getElementById("empty-auth");
const emptyCheckSubBtn = document.getElementById("empty-check-sub");
const emptyInstallCmd = document.getElementById("empty-install-cmd");
const emptyInstallPath = document.getElementById("empty-install-path");
/** Toggle empty-state auth CTA: Sign in when logged out, Log out when signed in (CLI/API). */
function updateEmptyAuthUi(hasAuth, authSummary, accessGated, gateMessage) {
  emptyHint.textContent = hasAuth
    ? authSummary || "Signed in. You can start chatting."
    : "Not signed in — use Sign in (browser OAuth or API key), same as grok login.";
  if (emptyGate) {
    if (hasAuth && accessGated && gateMessage) {
      emptyGate.hidden = false;
      emptyGate.textContent = gateMessage;
    } else {
      emptyGate.hidden = true;
      emptyGate.textContent = "";
    }
  }
  if (emptyCheckSubBtn) {
    emptyCheckSubBtn.hidden = !(hasAuth && accessGated);
  }
  if (!emptyAuthBtn) return;
  if (hasAuth) {
    emptyAuthBtn.setAttribute("data-action", "logout");
    emptyAuthBtn.title =
      "Sign out of Grok — clears CLI session (~/.grok/auth.json), same as grok logout";
    emptyAuthBtn.innerHTML = '<i class="ti ti-logout"></i> Log out';
  } else {
    emptyAuthBtn.setAttribute("data-action", "login");
    emptyAuthBtn.title = "Sign in with browser or API key (same as grok login)";
    emptyAuthBtn.innerHTML = '<i class="ti ti-login-2"></i> Sign in';
  }
}
/** True when the grok binary is not resolved — blocks chat until installed. */
let cliMissing = false;
/** Show install-CLI panel when binary is missing (blocks agent use). */
function updateEmptyCliUi(cliFound, installCommand, typicalPath) {
  cliMissing = !cliFound;
  emptyEl.classList.toggle("cli-missing", cliMissing);
  if (emptyReady) emptyReady.hidden = cliMissing;
  if (emptyCliMissing) emptyCliMissing.hidden = !cliMissing;
  if (emptyInstallCmd && installCommand) {
    emptyInstallCmd.textContent = installCommand;
  }
  if (emptyInstallPath) {
    emptyInstallPath.textContent = typicalPath
      ? "Typical path after install: " + typicalPath
      : "";
  }
  // Soft-lock composer when CLI is missing
  if (composer) {
    composer.disabled = cliMissing;
    syncComposerPlaceholder();
  }
  updateSendStopButton();
}
const meta = document.getElementById("meta");
const composer = document.getElementById("composer");
const sendBtn = document.getElementById("send");
const stickyEl = document.getElementById("sticky");
const reviewBar = document.getElementById("review-bar");
const reviewLabel = document.getElementById("review-label");
const ctxBarEl = document.getElementById("ctx-bar");
const ctxUsageEl = document.getElementById("ctx-usage");
const ctxUsageTextEl = document.getElementById("ctx-usage-text");
const ctxRingFillEl = ctxUsageEl
  ? ctxUsageEl.querySelector(".ctx-ring-fill")
  : null;
/** Circumference for r=14 circle progress (2πr). */
const CTX_RING_C = 2 * Math.PI * 14;
const turnStatusEl = document.getElementById("turn-status");
const tsProcess = turnStatusEl.querySelector(".ts-process");
const tsTime = turnStatusEl.querySelector(".ts-time");
const tsTokens = turnStatusEl.querySelector(".ts-tokens");
const tsCost = turnStatusEl.querySelector(".ts-cost");
const mentionPopover = document.getElementById("mention-popover");
const mentionList = document.getElementById("mention-list");
const mentionEmpty = document.getElementById("mention-empty");
const mentionTitle = document.getElementById("mention-title");
const slashPopover = document.getElementById("slash-popover");
const slashList = document.getElementById("slash-list");
const slashEmpty = document.getElementById("slash-empty");
const slashTitle = document.getElementById("slash-title");
const modelPopover = document.getElementById("model-popover");
const modelList = document.getElementById("model-list");
const modelEmpty = document.getElementById("model-empty");
const modelTitle = document.getElementById("model-title");
const btnModel = document.getElementById("btn-model");
const modelBtnLabel = document.getElementById("model-btn-label");
const effortPopover = document.getElementById("effort-popover");
const effortList = document.getElementById("effort-list");
const effortEmpty = document.getElementById("effort-empty");
const effortTitle = document.getElementById("effort-title");
const btnEffort = document.getElementById("btn-effort");
const effortBtnLabel = document.getElementById("effort-btn-label");
const btnMode = document.getElementById("btn-mode");
const modeBtnLabel = document.getElementById("mode-btn-label");
const permissionPopover = document.getElementById("permission-popover");
const permissionTitle = document.getElementById("permission-title");
const permissionDetail = document.getElementById("permission-detail");
const permissionList = document.getElementById("permission-list");
const permissionCancel = document.getElementById("permission-cancel");
const questionPopover = document.getElementById("question-popover");
const questionTitle = document.getElementById("question-title");
const questionTabs = document.getElementById("question-tabs");
const questionBody = document.getElementById("question-body");
const questionList = document.getElementById("question-list");
const questionNotes = document.getElementById("question-notes");
const questionCancel = document.getElementById("question-cancel");
const questionChat = document.getElementById("question-chat");
const questionSkip = document.getElementById("question-skip");
const questionAccept = document.getElementById("question-accept");
const planPanel = document.getElementById("plan-panel");
const planTitle = document.getElementById("plan-title");
const planBadge = document.getElementById("plan-badge");
const planBody = document.getElementById("plan-body");
const planAbandon = document.getElementById("plan-abandon");
const planRequest = document.getElementById("plan-request");
const planApprove = document.getElementById("plan-approve");
const sessionRewindPanel = document.getElementById("session-rewind-panel");
const sessionRewindTitle = document.getElementById("session-rewind-title");
const sessionRewindBadge = document.getElementById("session-rewind-badge");
const sessionRewindBody = document.getElementById("session-rewind-body");
const sessionRewindFoot = document.getElementById("session-rewind-foot");
const sessionRewindBack = document.getElementById("session-rewind-back");
const sessionRewindClose = document.getElementById("session-rewind-close");
const sessionRewindCancelBtn = document.getElementById(
  "session-rewind-cancel-btn",
);
const sessionRewindConfirmBtn = document.getElementById(
  "session-rewind-confirm-btn",
);
const subagentPanel = document.getElementById("subagent-panel");
const subagentTypeEl = document.getElementById("subagent-type");
const subagentStatusEl = document.getElementById("subagent-status");
const subagentDescEl = document.getElementById("subagent-desc");
const subagentChipsEl = document.getElementById("subagent-chips");
const subagentBody = document.getElementById("subagent-body");
const subagentTimeline = document.getElementById("subagent-timeline");
const subagentSnapshotWrap = document.getElementById("subagent-snapshot-wrap");
const subagentClose = document.getElementById("subagent-close");
const subagentDone = document.getElementById("subagent-done");
const subagentRefresh = document.getElementById("subagent-refresh");
const subagentKill = document.getElementById("subagent-kill");
const appRoot = document.getElementById("app");
let busy = false;
/** In-chat multi-step session rewind (not the edit-mode popover). */
let sessionRewindOpen = false;
let sessionRewindPhase = "points"; // points | mode | confirm | busy | error
let sessionRewindIndex = 0;
let sessionRewindItems = []; // current list for keyboard nav
/** In-chat subagent detail panel (plan-panel twin). */
let subagentOpen = false;
let subagentActiveId = "";
/** Last rendered live messages for patch-in-place. */
let subagentLiveMessages = [];
let currentMode = "normal";
let allMessages = [];
let stickyChips = [];
let autoAttachEnabled = true;
let autoChip = null; // { id, label, kind, fsPath } | null
/** Shared prompt queue rows (TUI queue pane). */
let queueEntries = [];
let queueEditActive = false;
/** Background tasks / subagents / loops (extension Tasks panel). */
let taskItems = [];
/** Agent catalog — same source as TUI ModelsManager.available(). */
let modelItems = [];
let currentModelId = "";
let currentModelLabel = "model";
let modelOpen = false;
let modelIndex = 0;
/** Reasoning effort menu for current model (TUI sessionConfig category mode). */
let effortItems = [];
let currentEffortId = "";
let currentEffortLabel = "";
let effortOpen = false;
let effortIndex = 0;
const EST_ROW = 96;
const VIRT_THRESHOLD = 40;

/* ── model + effort popovers (TUI /model + /effort) ── */
function setModelButtonLabel(label) {
  currentModelLabel = label || currentModelId || "model";
  modelBtnLabel.textContent = currentModelLabel;
  btnModel.title = "Model: " + currentModelLabel + " (same catalog as TUI)";
}

function setEffortButtonLabel(label) {
  currentEffortLabel = label || currentEffortId || "";
  if (!effortItems.length) {
    btnEffort.hidden = true;
    return;
  }
  btnEffort.hidden = false;
  effortBtnLabel.textContent = currentEffortLabel || "effort";
  btnEffort.title =
    "Reasoning effort: " + (currentEffortLabel || currentEffortId || "—");
}

/** Map cycle mode id → button label (keep in sync with sessionModeCycle.ts). */
function modeLabelForId(id) {
  switch (String(id || "")) {
    case "plan":
      return "Plan";
    case "auto":
      return "Auto";
    case "always-approve":
      return "Always Approve";
    case "normal":
    default:
      return "Normal";
  }
}

function modeCssForId(id) {
  switch (String(id || "")) {
    case "plan":
      return "mode-plan";
    case "auto":
      return "mode-auto";
    case "always-approve":
      return "mode-always-approve";
    case "normal":
    default:
      return "mode-normal";
  }
}

function applyModeState(s) {
  if (!s) return;
  if (s.mode) currentMode = String(s.mode);
  const label = s.modeLabel || s.label || modeLabelForId(currentMode);
  modeBtnLabel.textContent = label;
  const css = s.modeCss || modeCssForId(currentMode);
  btnMode.className = "secondary " + css;
  btnMode.title = s.modeTitle || "Mode: " + label + " (Shift+Tab)";
}

function applyModelsState(s) {
  if (!s) return;
  if (Array.isArray(s.models)) {
    modelItems = s.models.slice();
  }
  if (s.currentModelId != null) currentModelId = String(s.currentModelId || "");
  if (s.currentLabel) setModelButtonLabel(s.currentLabel);
  else if (currentModelId) {
    const hit = modelItems.find((m) => m.id === currentModelId);
    setModelButtonLabel(hit ? hit.label : currentModelId);
  }
  if (Array.isArray(s.efforts)) {
    effortItems = s.efforts.slice();
  }
  if (s.currentEffortId != null)
    currentEffortId = String(s.currentEffortId || "");
  if (s.currentEffortLabel) setEffortButtonLabel(s.currentEffortLabel);
  else
    setEffortButtonLabel(
      (effortItems.find((e) => e.id === currentEffortId) || {}).label ||
        currentEffortId,
    );
  if (modelOpen) renderModelList();
  if (effortOpen) renderEffortList();
}

function closeModelPopover() {
  modelOpen = false;
  modelPopover.hidden = true;
  modelList.innerHTML = "";
  modelEmpty.hidden = true;
}

function closeEffortPopover() {
  effortOpen = false;
  effortPopover.hidden = true;
  effortList.innerHTML = "";
  effortEmpty.hidden = true;
}

/* ── permission + question popovers (TUI overlays) ── */
let permissionOpen = false;
let permissionPromptId = 0;
let permissionItems = [];
let permissionIndex = 0;
let questionOpen = false;
let questionPromptId = 0;
let questionMode = "default";
let questionItems = []; // full questions array
let questionTab = 0;
let questionSelections = []; // per-tab: number | Set
let questionIndex = 0;
let questionNotesByTab = [];
/* Plan approval panel — full-width body UI (not a composer popover). */
let planOpen = false;
let planPromptId = 0;

function closeOtherDropdowns() {
  if (typeof closeModelPopover === "function") closeModelPopover();
  if (typeof closeEffortPopover === "function") closeEffortPopover();
  if (typeof closeSlash === "function") closeSlash();
  if (typeof closeMention === "function") closeMention();
  if (typeof closeRewindPopover === "function") closeRewindPopover();
}

function closePermissionPopover(send) {
  if (!permissionOpen && permissionPopover.hidden) return;
  const id = permissionPromptId;
  permissionOpen = false;
  permissionPopover.hidden = true;
  permissionList.innerHTML = "";
  permissionItems = [];
  if (send) {
    vscode.postMessage({
      type: "permissionResponse",
      promptId: id,
      outcome: send.outcome,
      optionId: send.optionId,
    });
  }
}

function openPermissionPrompt(msg) {
  closeOtherDropdowns();
  closeQuestionPopover(null);
  // Plan panel stays open if present — permission is a separate modal.
  permissionOpen = true;
  permissionPromptId = msg.promptId || 0;
  permissionItems = msg.options || [];
  permissionIndex = 0;
  permissionTitle.textContent = msg.title ? String(msg.title) : "Permission";
  permissionDetail.textContent = msg.detail ? String(msg.detail) : "";
  permissionPopover.hidden = false;
  renderPermissionList();
  // Focus list so keyboard works even if composer isn't focused
  const first = permissionList.querySelector(".permission-item");
  if (first) first.focus();
}

function renderPermissionList() {
  if (!permissionOpen) return;
  permissionList.innerHTML = permissionItems
    .map((o, i) => {
      const icon = o.icon || "ti-circle-dot";
      const kind = o.kind || "";
      const label = o.label || o.name || o.optionId || "";
      const desc = o.kind || "";
      return (
        '<button type="button" class="permission-item kind-' +
        esc(kind) +
        (i === permissionIndex ? " active" : "") +
        '" data-i="' +
        i +
        '" role="option" tabindex="0" aria-selected="' +
        (i === permissionIndex ? "true" : "false") +
        '">' +
        '<span class="mi-icon"><i class="ti ' +
        esc(icon) +
        '"></i></span>' +
        '<span class="mi-body"><span class="mi-label">' +
        esc(label) +
        "</span>" +
        '<span class="mi-desc">' +
        esc(desc) +
        "</span></span>" +
        "</button>"
      );
    })
    .join("");
  highlightPermissionIndex(false);
}

/** Update active row without rebuilding DOM (avoids killing click on mouseenter). */
function highlightPermissionIndex(scroll) {
  const buttons = permissionList.querySelectorAll(".permission-item");
  buttons.forEach((btn, i) => {
    const on = i === permissionIndex;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
    if (on && scroll) btn.scrollIntoView({ block: "nearest" });
  });
}

function movePermission(delta) {
  if (!permissionItems.length) return;
  permissionIndex =
    (permissionIndex + delta + permissionItems.length) % permissionItems.length;
  highlightPermissionIndex(true);
}

function acceptPermission(i) {
  const idx = typeof i === "number" ? i : permissionIndex;
  const o = permissionItems[idx];
  if (!o || !o.optionId) return;
  closePermissionPopover({ outcome: "selected", optionId: o.optionId });
}

// Event delegation — stable handlers (re-render must not re-bind)
permissionList.addEventListener("click", (e) => {
  const btn =
    e.target && e.target.closest ? e.target.closest(".permission-item") : null;
  if (!btn || !permissionOpen) return;
  e.preventDefault();
  e.stopPropagation();
  const i = Number(btn.getAttribute("data-i"));
  if (Number.isFinite(i)) acceptPermission(i);
});
permissionList.addEventListener("mouseover", (e) => {
  const btn =
    e.target && e.target.closest ? e.target.closest(".permission-item") : null;
  if (!btn || !permissionOpen) return;
  const i = Number(btn.getAttribute("data-i"));
  if (!Number.isFinite(i) || i === permissionIndex) return;
  permissionIndex = i;
  highlightPermissionIndex(false);
});

function closeQuestionPopover(send) {
  if (!questionOpen && questionPopover.hidden) return;
  const id = questionPromptId;
  questionOpen = false;
  questionPopover.hidden = true;
  questionList.innerHTML = "";
  questionTabs.innerHTML = "";
  questionBody.textContent = "";
  questionNotes.value = "";
  questionNotes.hidden = true;
  questionItems = [];
  questionSelections = [];
  questionNotesByTab = [];
  if (send) {
    vscode.postMessage(
      Object.assign({ type: "questionResponse", promptId: id }, send),
    );
  }
}

function openQuestionPrompt(msg) {
  closeOtherDropdowns();
  closePermissionPopover(null);
  questionOpen = true;
  questionPromptId = msg.promptId || 0;
  questionMode = msg.mode === "plan" ? "plan" : "default";
  questionItems = msg.questions || [];
  questionTab = 0;
  questionIndex = 0;
  questionSelections = questionItems.map((q) =>
    q.multiSelect ? new Set() : null,
  );
  questionNotesByTab = questionItems.map(() => "");
  questionTitle.textContent =
    questionItems.length > 1
      ? "Questions (" + questionItems.length + ")"
      : "Question";
  questionChat.hidden = questionMode !== "plan";
  questionSkip.hidden = questionMode !== "plan";
  questionPopover.hidden = false;
  renderQuestionView();
  const first = questionList.querySelector(".question-item");
  if (first) first.focus();
}

function saveQuestionNotes() {
  if (questionTab >= 0 && questionTab < questionNotesByTab.length) {
    questionNotesByTab[questionTab] = questionNotes.value || "";
  }
}

function renderQuestionView() {
  if (!questionOpen) return;
  const q = questionItems[questionTab];
  if (!q) return;
  // tabs
  if (questionItems.length > 1) {
    questionTabs.innerHTML = questionItems
      .map(
        (qq, i) =>
          '<button type="button" class="q-tab' +
          (i === questionTab ? " active" : "") +
          '" data-i="' +
          i +
          '">Q' +
          (i + 1) +
          "</button>",
      )
      .join("");
  } else {
    questionTabs.innerHTML = "";
  }
  questionBody.textContent = q.question || "";
  questionNotes.hidden = false;
  questionNotes.value = questionNotesByTab[questionTab] || "";
  const opts = q.options || [];
  const sel = questionSelections[questionTab];
  questionList.innerHTML = opts
    .map((o, i) => {
      const selected = q.multiSelect ? !!(sel && sel.has(i)) : sel === i;
      return (
        '<button type="button" class="question-item' +
        (i === questionIndex ? " active" : "") +
        (selected ? " selected" : "") +
        '" data-i="' +
        i +
        '" role="option" tabindex="0">' +
        '<span class="mi-check"><i class="ti ti-check"></i></span>' +
        '<span class="mi-body"><span class="mi-label">' +
        esc(o.label || "") +
        "</span>" +
        '<span class="mi-desc">' +
        esc(o.description || "") +
        "</span></span>" +
        "</button>"
      );
    })
    .join("");
  highlightQuestionIndex(false);
}

function highlightQuestionIndex(scroll) {
  const q = questionItems[questionTab];
  const sel = questionSelections[questionTab];
  const buttons = questionList.querySelectorAll(".question-item");
  buttons.forEach((btn, i) => {
    const on = i === questionIndex;
    btn.classList.toggle("active", on);
    const selected = q && q.multiSelect ? !!(sel && sel.has(i)) : sel === i;
    btn.classList.toggle("selected", selected);
    if (on && scroll) btn.scrollIntoView({ block: "nearest" });
  });
}

function toggleQuestionOption(i) {
  const q = questionItems[questionTab];
  if (!q) return;
  if (q.multiSelect) {
    const set = questionSelections[questionTab] || new Set();
    if (set.has(i)) set.delete(i);
    else set.add(i);
    questionSelections[questionTab] = set;
  } else {
    questionSelections[questionTab] = i;
  }
  questionIndex = i;
  highlightQuestionIndex(false);
}

function moveQuestion(delta) {
  const q = questionItems[questionTab];
  if (!q || !(q.options || []).length) return;
  const n = q.options.length;
  questionIndex = (questionIndex + delta + n) % n;
  highlightQuestionIndex(true);
}

questionTabs.addEventListener("click", (e) => {
  const btn = e.target && e.target.closest ? e.target.closest(".q-tab") : null;
  if (!btn || !questionOpen) return;
  e.preventDefault();
  saveQuestionNotes();
  questionTab = Number(btn.getAttribute("data-i")) || 0;
  questionIndex = 0;
  renderQuestionView();
});
questionList.addEventListener("click", (e) => {
  const btn =
    e.target && e.target.closest ? e.target.closest(".question-item") : null;
  if (!btn || !questionOpen) return;
  e.preventDefault();
  e.stopPropagation();
  const i = Number(btn.getAttribute("data-i"));
  if (Number.isFinite(i)) toggleQuestionOption(i);
});
questionList.addEventListener("mouseover", (e) => {
  const btn =
    e.target && e.target.closest ? e.target.closest(".question-item") : null;
  if (!btn || !questionOpen) return;
  const i = Number(btn.getAttribute("data-i"));
  if (!Number.isFinite(i) || i === questionIndex) return;
  questionIndex = i;
  highlightQuestionIndex(false);
});

function buildQuestionAnswers() {
  saveQuestionNotes();
  const answers = {};
  const annotations = {};
  let any = false;
  questionItems.forEach((q, ti) => {
    const sel = questionSelections[ti];
    const labels = [];
    let preview;
    if (q.multiSelect && sel && sel.size) {
      Array.from(sel)
        .sort((a, b) => a - b)
        .forEach((i) => {
          const o = q.options[i];
          if (o) labels.push(o.label);
        });
    } else if (typeof sel === "number" && q.options[sel]) {
      labels.push(q.options[sel].label);
      if (q.options[sel].preview) preview = q.options[sel].preview;
    }
    const notes = (questionNotesByTab[ti] || "").trim();
    // Freeform-only (TUI): no option picked but notes → answer "Other"
    if (!labels.length && notes) {
      labels.push("Other");
    }
    if (labels.length) {
      answers[q.question] = labels;
      any = true;
    }
    if (preview || notes) {
      annotations[q.question] = {};
      if (preview) annotations[q.question].preview = preview;
      if (notes) annotations[q.question].notes = notes;
    }
  });
  return { answers, annotations, any };
}

function acceptQuestion() {
  const { answers, annotations, any } = buildQuestionAnswers();
  if (!any) return;
  const payload = { outcome: "accepted", answers };
  if (Object.keys(annotations).length) payload.annotations = annotations;
  closeQuestionPopover(payload);
}

function partialAnswersFromSelections() {
  const { answers } = buildQuestionAnswers();
  const partial = {};
  Object.keys(answers).forEach((k) => {
    partial[k] = answers[k].join(", ");
  });
  return partial;
}

permissionCancel.addEventListener("click", () => {
  closePermissionPopover({ outcome: "cancelled" });
});
questionCancel.addEventListener("click", () => {
  closeQuestionPopover({ outcome: "cancelled" });
});
questionAccept.addEventListener("click", () => acceptQuestion());
questionChat.addEventListener("click", () => {
  closeQuestionPopover({
    outcome: "chat_about_this",
    partial_answers: partialAnswersFromSelections(),
  });
});
questionSkip.addEventListener("click", () => {
  closeQuestionPopover({
    outcome: "skip_interview",
    partial_answers: partialAnswersFromSelections(),
  });
});

function closePlanPanel(send) {
  if (!planOpen && (!planPanel || planPanel.hidden)) return;
  const id = planPromptId;
  planOpen = false;
  planPromptId = 0;
  if (planPanel) planPanel.hidden = true;
  if (appRoot) appRoot.classList.remove("plan-open");
  if (planBody) planBody.innerHTML = "";
  if (planBadge) planBadge.hidden = true;
  syncComposerPlaceholder();
  updateSendStopButton();
  if (send) {
    vscode.postMessage({
      type: "planApprovalResponse",
      promptId: id,
      outcome: send.outcome,
      feedback: send.feedback,
    });
  }
}

function closeSubagentPanel(notifyHost) {
  if (!subagentOpen && (!subagentPanel || subagentPanel.hidden)) return;
  const id = subagentActiveId;
  subagentOpen = false;
  subagentActiveId = "";
  subagentLiveMessages = [];
  if (subagentPanel) {
    subagentPanel.hidden = true;
    subagentPanel.classList.remove("live");
  }
  if (appRoot) appRoot.classList.remove("subagent-open");
  if (subagentBody) subagentBody.innerHTML = "";
  if (subagentTimeline) subagentTimeline.innerHTML = "";
  if (subagentSnapshotWrap) subagentSnapshotWrap.hidden = true;
  if (subagentChipsEl) {
    subagentChipsEl.innerHTML = "";
    subagentChipsEl.hidden = true;
  }
  if (subagentDescEl) subagentDescEl.textContent = "";
  if (subagentKill) subagentKill.hidden = true;
  if (notifyHost && id) {
    vscode.postMessage({ type: "subagentPanelClose", id });
  }
}

function applySubagentMeta(msg) {
  if (subagentTypeEl) {
    subagentTypeEl.textContent = msg.typeLabel
      ? "Subagent · " + msg.typeLabel
      : "Subagent";
  }
  if (subagentStatusEl) {
    const st = msg.statusLabel || msg.status || "unknown";
    subagentStatusEl.textContent = st;
    subagentStatusEl.className =
      "subagent-badge status-" + String(st).replace(/\s+/g, "-");
  }
  if (subagentDescEl) {
    subagentDescEl.textContent = msg.description || "";
    subagentDescEl.title = msg.description || "";
  }
  if (subagentChipsEl) {
    const chips = Array.isArray(msg.chips) ? msg.chips : [];
    subagentChipsEl.innerHTML = "";
    if (chips.length === 0) {
      subagentChipsEl.hidden = true;
    } else {
      subagentChipsEl.hidden = false;
      chips.forEach((c) => {
        const span = document.createElement("span");
        span.className = "subagent-chip";
        span.textContent = String(c);
        subagentChipsEl.appendChild(span);
      });
    }
  }
  if (subagentKill) {
    subagentKill.hidden = !msg.canKill;
  }
  if (subagentPanel) {
    subagentPanel.classList.toggle("live", !!msg.live);
  }
}

/**
 * Render live child timeline into #subagent-timeline using the same assistant
 * timeline builder as main chat (thoughts / tools / text).
 */
function renderSubagentTimeline(messages, stickBottom) {
  if (!subagentTimeline) return;
  const list = Array.isArray(messages) ? messages : [];
  const scroll = document.getElementById("subagent-scroll");
  const nearBottom =
    !scroll ||
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  subagentTimeline.innerHTML = "";
  const openToolIds = new Set();
  const openThoughtIds = new Set();
  const openGroupIds = new Set();
  list.forEach((m) => {
    if (!m) return;
    if (m.type === "user") {
      const el = document.createElement("div");
      el.className = "msg user";
      el.dataset.id = m.id || "";
      const bubble = document.createElement("div");
      bubble.className = "bubble md";
      if (m.html) {
        bubble.innerHTML = m.html;
        if (typeof attachCopyButtons === "function") attachCopyButtons(bubble);
      } else {
        bubble.textContent = m.text || "";
      }
      el.appendChild(bubble);
      subagentTimeline.appendChild(el);
      return;
    }
    if (m.type === "system") {
      const el = document.createElement("div");
      el.className = "msg system";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.text || "";
      el.appendChild(bubble);
      subagentTimeline.appendChild(el);
      return;
    }
    if (m.type === "assistant") {
      const el = document.createElement("div");
      el.className = "msg assistant subagent-msg";
      el.dataset.id = m.id || "";
      // Reuse main-chat timeline renderer (thinking / tools / text).
      // Do NOT force stream-shimmer here: parent `busy` + empty assistant
      // skeleton looks wrong inside the subagent panel while the child works.
      if (typeof renderAssistantTimeline === "function") {
        const timeline = renderAssistantTimeline(
          m,
          openToolIds,
          openThoughtIds,
          openGroupIds,
        );
        if (timeline) {
          // Strip main-chat live skeleton if the renderer attached one.
          timeline
            .querySelectorAll(":scope > .stream-shimmer")
            .forEach((s) => s.remove());
          timeline.classList.add("stream-settled");
          el.appendChild(timeline);
        }
      } else {
        const bubble = document.createElement("div");
        bubble.className = "bubble md";
        if (m.html) bubble.innerHTML = m.html;
        else bubble.textContent = m.text || "";
        el.appendChild(bubble);
      }
      // Skip empty assistant shells (no visible timeline content yet).
      const tl = el.querySelector(".assistant-timeline");
      const hasContent =
        (tl &&
          Array.from(tl.children).some(
            (c) => !c.classList.contains("stream-shimmer"),
          )) ||
        el.querySelector(".bubble");
      if (!hasContent) {
        return;
      }
      subagentTimeline.appendChild(el);
    }
  });
  subagentLiveMessages = list;
  if (scroll && (stickBottom || nearBottom)) {
    scroll.scrollTop = scroll.scrollHeight;
  }
}

function openSubagentPanel(msg) {
  closeOtherDropdowns();
  // Don't stack with plan approval.
  if (planOpen) closePlanPanel(null);
  subagentOpen = true;
  subagentActiveId = msg.subagentId || msg.id || "";
  if (appRoot) appRoot.classList.add("subagent-open");
  applySubagentMeta(msg);

  const hasLiveMsgs = Array.isArray(msg.messages) && msg.messages.length > 0;
  if (hasLiveMsgs || msg.live) {
    if (subagentSnapshotWrap) subagentSnapshotWrap.hidden = true;
    renderSubagentTimeline(msg.messages || [], true);
  } else {
    if (subagentTimeline) subagentTimeline.innerHTML = "";
    if (subagentSnapshotWrap) subagentSnapshotWrap.hidden = false;
    if (subagentBody) {
      subagentBody.className = "bubble md";
      if (msg.bodyHtml) {
        subagentBody.innerHTML = msg.bodyHtml;
        if (typeof attachCopyButtons === "function") {
          attachCopyButtons(subagentBody);
        }
      } else {
        subagentBody.textContent = msg.bodyMarkdown
          ? String(msg.bodyMarkdown)
          : "";
      }
    }
  }

  // Optional snapshot footer when hybrid finished view sends snapshotHtml.
  if (msg.snapshotHtml && subagentSnapshotWrap && subagentBody) {
    subagentSnapshotWrap.hidden = false;
    subagentBody.className = "bubble md";
    subagentBody.innerHTML = msg.snapshotHtml;
    if (typeof attachCopyButtons === "function") {
      attachCopyButtons(subagentBody);
    }
  }

  const scroll = document.getElementById("subagent-scroll");
  if (scroll && !hasLiveMsgs) scroll.scrollTop = 0;
  if (subagentPanel) subagentPanel.hidden = false;
}

function updateSubagentPanel(msg) {
  if (!subagentOpen) {
    openSubagentPanel(msg);
    return;
  }
  if (msg.subagentId) subagentActiveId = msg.subagentId;
  applySubagentMeta(msg);
  if (Array.isArray(msg.messages)) {
    if (subagentSnapshotWrap && !msg.snapshotHtml) {
      subagentSnapshotWrap.hidden = true;
    }
    renderSubagentTimeline(msg.messages, false);
  }
  if (msg.snapshotHtml && subagentSnapshotWrap && subagentBody) {
    subagentSnapshotWrap.hidden = false;
    subagentBody.className = "bubble md";
    subagentBody.innerHTML = msg.snapshotHtml;
    if (typeof attachCopyButtons === "function") {
      attachCopyButtons(subagentBody);
    }
  } else if (msg.bodyHtml && !msg.live && subagentBody) {
    if (subagentSnapshotWrap) subagentSnapshotWrap.hidden = false;
    subagentBody.className = "bubble md";
    subagentBody.innerHTML = msg.bodyHtml;
    if (typeof attachCopyButtons === "function") {
      attachCopyButtons(subagentBody);
    }
  }
}

function openPlanPanel(msg) {
  closeOtherDropdowns();
  if (subagentOpen) closeSubagentPanel(false);
  planOpen = true;
  planPromptId = msg.promptId || 0;
  if (appRoot) appRoot.classList.add("plan-open");
  if (planTitle) {
    planTitle.textContent =
      msg.hasPlan === false ? "Exit plan mode" : "Plan approval";
  }
  if (planBadge) {
    const empty = msg.hasPlan === false;
    planBadge.hidden = !empty;
    planBadge.textContent = empty ? "No plan written" : "";
  }
  if (planBody) {
    // Same host pipeline as assistant messages: sanitized HTML + code Copy.
    planBody.className = "bubble md";
    if (msg.planHtml) {
      planBody.innerHTML = msg.planHtml;
      if (typeof attachCopyButtons === "function") {
        attachCopyButtons(planBody);
      }
    } else {
      planBody.textContent = msg.planContent ? String(msg.planContent) : "";
    }
  }
  const planScroll = document.getElementById("plan-scroll");
  if (planScroll) planScroll.scrollTop = 0;
  if (planPanel) planPanel.hidden = false;
  // Request changes uses the composer as feedback.
  syncComposerPlaceholder();
  updateSendStopButton();
  if (composer) composer.focus();
}

/** Composer text becomes plan feedback; clear after send. */
function submitPlanRequestChanges() {
  if (!planOpen) return;
  const feedback = composer ? composer.value : "";
  if (composer) {
    composer.value = "";
    if (typeof autosizeComposer === "function") autosizeComposer();
  }
  closePlanPanel({
    outcome: "cancelled",
    feedback: feedback,
  });
}

if (planAbandon) {
  planAbandon.addEventListener("click", () => {
    closePlanPanel({ outcome: "abandoned" });
  });
}
if (subagentClose) {
  subagentClose.addEventListener("click", () => closeSubagentPanel(true));
}
if (subagentDone) {
  subagentDone.addEventListener("click", () => closeSubagentPanel(true));
}
if (subagentRefresh) {
  subagentRefresh.addEventListener("click", () => {
    if (!subagentActiveId) return;
    vscode.postMessage({
      type: "subagentPanelRefresh",
      id: subagentActiveId,
    });
  });
}
if (subagentKill) {
  subagentKill.addEventListener("click", () => {
    if (!subagentActiveId) return;
    vscode.postMessage({
      type: "subagentPanelKill",
      id: subagentActiveId,
    });
  });
}
if (planRequest) {
  planRequest.addEventListener("click", () => {
    submitPlanRequestChanges();
  });
}
if (planApprove) {
  planApprove.addEventListener("click", () => {
    closePlanPanel({ outcome: "approved" });
  });
}

function renderModelList() {
  if (!modelOpen) return;
  modelPopover.hidden = false;
  modelTitle.textContent =
    "Models" + (modelItems.length ? " (" + modelItems.length + ")" : "");
  if (!modelItems.length) {
    modelList.innerHTML = "";
    modelEmpty.hidden = false;
    modelEmpty.textContent = "Waiting for agent catalog…";
    return;
  }
  modelEmpty.hidden = true;
  modelList.innerHTML = modelItems
    .map((m, i) => {
      const cur = m.id === currentModelId || m.selected;
      return (
        '<button type="button" class="model-item' +
        (i === modelIndex ? " active" : "") +
        (cur ? " current" : "") +
        '" role="option" data-model-idx="' +
        i +
        '" aria-selected="' +
        (i === modelIndex) +
        '">' +
        '<span class="mi-icon">' +
        icon(cur ? "check" : "cpu") +
        "</span>" +
        '<span class="mi-body">' +
        '<span class="mi-label">' +
        esc(m.label || m.id) +
        "</span>" +
        (m.id && m.id !== m.label
          ? '<span class="mi-desc">' + esc(m.id) + "</span>"
          : m.description
            ? '<span class="mi-desc">' + esc(m.description) + "</span>"
            : "") +
        "</span>" +
        (cur ? '<span class="mi-badge">current</span>' : "") +
        "</button>"
      );
    })
    .join("");
  const active = modelList.querySelector(".model-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function renderEffortList() {
  if (!effortOpen) return;
  effortPopover.hidden = false;
  effortTitle.textContent = "Reasoning";
  if (!effortItems.length) {
    effortList.innerHTML = "";
    effortEmpty.hidden = false;
    return;
  }
  effortEmpty.hidden = true;
  effortList.innerHTML = effortItems
    .map((e, i) => {
      const cur = e.id === currentEffortId || e.selected;
      return (
        '<button type="button" class="effort-item' +
        (i === effortIndex ? " active" : "") +
        (cur ? " current" : "") +
        '" role="option" data-effort-idx="' +
        i +
        '" aria-selected="' +
        (i === effortIndex) +
        '">' +
        '<span class="mi-icon">' +
        icon(cur ? "check" : "brain") +
        "</span>" +
        '<span class="mi-body">' +
        '<span class="mi-label">' +
        esc(e.label || e.id) +
        "</span>" +
        (e.description
          ? '<span class="mi-desc">' + esc(e.description) + "</span>"
          : "") +
        "</span>" +
        (cur ? '<span class="mi-badge">current</span>' : "") +
        "</button>"
      );
    })
    .join("");
  const active = effortList.querySelector(".effort-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function focusPopoverActive(listEl, selector) {
  requestAnimationFrame(() => {
    const el =
      (listEl && listEl.querySelector(selector + ".active")) ||
      (listEl && listEl.querySelector(selector));
    if (el && typeof el.focus === "function") {
      try {
        el.focus();
      } catch (_) {
        /* ignore */
      }
    }
  });
}

function openModelPopover() {
  if (slashOpen) closeSlash();
  if (mentionOpen) closeMention();
  if (effortOpen) closeEffortPopover();
  // Always re-fetch catalog from agent so we don't stick on bundled fallback
  // until some other server action happens to start the agent.
  vscode.postMessage({ type: "ensureModels" });
  modelOpen = true;
  modelIndex = Math.max(
    0,
    modelItems.findIndex((m) => m.id === currentModelId),
  );
  if (modelIndex < 0) modelIndex = 0;
  renderModelList();
  // Focus list so keyboard works even when opened from the model button.
  // Empty catalog shows "Waiting for agent catalog…" until models post arrives.
  focusPopoverActive(modelList, ".model-item");
}

function openEffortPopover() {
  if (slashOpen) closeSlash();
  if (mentionOpen) closeMention();
  if (modelOpen) closeModelPopover();
  if (!effortItems.length) return;
  effortOpen = true;
  effortIndex = Math.max(
    0,
    effortItems.findIndex((e) => e.id === currentEffortId),
  );
  if (effortIndex < 0) effortIndex = 0;
  renderEffortList();
  focusPopoverActive(effortList, ".effort-item");
}

function acceptModel(idx) {
  const m = modelItems[idx];
  if (!m || !m.id) return;
  closeModelPopover();
  if (m.id === currentModelId) return;
  vscode.postMessage({ type: "setModel", modelId: m.id });
}

function acceptEffort(idx) {
  const e = effortItems[idx];
  if (!e || !e.id) return;
  closeEffortPopover();
  if (e.id === currentEffortId) return;
  vscode.postMessage({ type: "setEffort", effortId: e.id });
}

function moveModel(delta) {
  if (!modelItems.length) return;
  modelIndex = (modelIndex + delta + modelItems.length) % modelItems.length;
  renderModelList();
}

function moveEffort(delta) {
  if (!effortItems.length) return;
  effortIndex = (effortIndex + delta + effortItems.length) % effortItems.length;
  renderEffortList();
}

/* ── / slash popover (synced with grok-build slash dropdown) ── */
let slashOpen = false;
let slashItems = [];
let slashIndex = 0;
let slashRequestId = 0;
let slashCtx = null; // { start, end, query, inCommand }
let slashSearchTimer = null;

function detectSlashContext(text, cursor) {
  if (cursor < 0 || cursor > text.length) return null;
  let i = 0;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length || text[i] !== "/") return null;
  const slashStart = i;
  let nameEnd = slashStart + 1;
  while (nameEnd < text.length && !/\s/.test(text[nameEnd])) {
    if (nameEnd > slashStart + 1 && text[nameEnd] === "/") return null;
    nameEnd++;
  }
  const inCommand = cursor >= slashStart && cursor <= nameEnd;
  if (!inCommand && cursor < nameEnd) return null;
  let argsStart = nameEnd;
  while (argsStart < text.length && /\s/.test(text[argsStart])) argsStart++;
  return {
    start: slashStart,
    end: nameEnd,
    query: inCommand
      ? text.slice(slashStart + 1, cursor)
      : text.slice(slashStart + 1, nameEnd),
    inCommand,
    args: text.slice(argsStart),
  };
}

function closeSlash() {
  slashOpen = false;
  slashItems = [];
  slashIndex = 0;
  slashCtx = null;
  slashPopover.hidden = true;
  slashList.innerHTML = "";
  slashEmpty.hidden = true;
  if (slashSearchTimer) {
    clearTimeout(slashSearchTimer);
    slashSearchTimer = null;
  }
}

function slashIconName(layer) {
  if (layer === "host") return "device-desktop";
  if (layer === "unsupported") return "device-desktop-off";
  return "robot";
}

function renderSlashList() {
  if (!slashOpen) return;
  slashPopover.hidden = false;
  slashTitle.textContent = slashCtx
    ? "/" + (slashCtx.query || "…")
    : "/ commands";
  if (!slashItems.length) {
    slashList.innerHTML = "";
    slashEmpty.hidden = false;
    slashEmpty.textContent = "No matches";
    return;
  }
  slashEmpty.hidden = true;
  slashList.innerHTML = slashItems
    .map(
      (it, i) =>
        '<button type="button" class="slash-item' +
        (i === slashIndex ? " active" : "") +
        '" role="option" data-slash-idx="' +
        i +
        '" aria-selected="' +
        (i === slashIndex) +
        '">' +
        '<span class="mi-icon">' +
        icon(slashIconName(it.layer)) +
        "</span>" +
        '<span class="mi-body">' +
        '<span class="mi-label">' +
        esc(it.display) +
        "</span>" +
        (it.description
          ? '<span class="mi-desc">' + esc(it.description) + "</span>"
          : "") +
        "</span>" +
        '<span class="mi-badge">' +
        esc(it.layer === "passthrough" ? "agent" : it.layer) +
        "</span>" +
        "</button>",
    )
    .join("");
  const active = slashList.querySelector(".slash-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function requestSlashSearch(query) {
  const requestId = ++slashRequestId;
  vscode.postMessage({ type: "searchSlash", query: query || "", requestId });
}

function openSlashFromContext(ctx) {
  if (mentionOpen) closeMention();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  slashOpen = true;
  slashCtx = ctx;
  slashIndex = 0;
  slashPopover.hidden = false;
  slashEmpty.hidden = false;
  slashEmpty.textContent = "Loading…";
  slashList.innerHTML = "";
  slashTitle.textContent = "/" + (ctx.query || "…");
  if (slashSearchTimer) clearTimeout(slashSearchTimer);
  slashSearchTimer = setTimeout(() => {
    requestSlashSearch(ctx.query || "");
  }, 20);
}

function syncSlashFromComposer() {
  const text = composer.value;
  const cursor = composer.selectionStart || 0;
  const ctx = detectSlashContext(text, cursor);
  // Only show dropdown while editing the command name (TUI parity).
  if (!ctx || !ctx.inCommand) {
    if (slashOpen) closeSlash();
    return;
  }
  const same =
    slashCtx && slashCtx.start === ctx.start && slashCtx.query === ctx.query;
  slashCtx = ctx;
  if (!slashOpen) {
    openSlashFromContext(ctx);
    return;
  }
  if (!same) {
    slashIndex = 0;
    if (slashSearchTimer) clearTimeout(slashSearchTimer);
    slashSearchTimer = setTimeout(() => {
      requestSlashSearch(ctx.query || "");
    }, 40);
    slashTitle.textContent = "/" + (ctx.query || "…");
  }
}

function acceptSlash(idx) {
  const item = slashItems[idx];
  if (!item) return;
  const text = composer.value;
  const ctx =
    slashCtx || detectSlashContext(text, composer.selectionStart || 0);
  if (ctx) {
    const after = text.slice(ctx.end);
    const next = text.slice(0, ctx.start) + item.insertText + after;
    composer.value = next;
    const pos = ctx.start + item.insertText.length;
    composer.setSelectionRange(pos, pos);
    autosizeComposer();
  }
  closeSlash();
  composer.focus();
  // If command takes no args, send immediately (TUI-like).
  if (!item.takesArgs) {
    sendBtn.click();
  }
}

function moveSlash(delta) {
  if (!slashItems.length) return;
  slashIndex = (slashIndex + delta + slashItems.length) % slashItems.length;
  renderSlashList();
}

/* ── @ mention popover (synced with grok-build file_search UX) ── */
let mentionOpen = false;
let mentionItems = [];
let mentionIndex = 0;
let mentionRequestId = 0;
let mentionAtCtx = null; // { start, end } of full @-token
let mentionSearchTimer = null;

function detectAtContext(text, cursor) {
  if (cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const atIdx = before.lastIndexOf("@");
  if (atIdx < 0) return null;
  if (atIdx > 0) {
    const prev = text[atIdx - 1];
    if (/[A-Za-z0-9_]/.test(prev)) return null;
  }
  let tokenEnd = text.length;
  for (let i = atIdx + 1; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch) || ch === "," || ch === ";") {
      tokenEnd = i;
      break;
    }
  }
  if (cursor > tokenEnd) return null;
  return {
    start: atIdx,
    end: tokenEnd,
    query: text.slice(atIdx + 1, cursor),
  };
}

function closeMention() {
  mentionOpen = false;
  mentionItems = [];
  mentionIndex = 0;
  mentionAtCtx = null;
  mentionPopover.hidden = true;
  mentionList.innerHTML = "";
  mentionEmpty.hidden = true;
  if (mentionSearchTimer) {
    clearTimeout(mentionSearchTimer);
    mentionSearchTimer = null;
  }
}

function syncComposerMenus() {
  // Prefer @ when inside @-token; else slash when leading /.
  const text = composer.value;
  const cursor = composer.selectionStart || 0;
  if (detectAtContext(text, cursor)) {
    if (slashOpen) closeSlash();
    syncMentionFromComposer();
    return;
  }
  if (mentionOpen) closeMention();
  syncSlashFromComposer();
}

function mentionIconName(icon) {
  if (icon === "folder") return "folder";
  if (icon === "selection") return "highlight";
  if (icon === "search") return "search";
  return "file";
}

function renderMentionList() {
  if (!mentionOpen) return;
  mentionPopover.hidden = false;
  mentionTitle.textContent = mentionAtCtx
    ? "@" + (mentionAtCtx.query || "…")
    : "@ context";
  if (!mentionItems.length) {
    mentionList.innerHTML = "";
    mentionEmpty.hidden = false;
    mentionEmpty.textContent = "No matches";
    return;
  }
  mentionEmpty.hidden = true;
  mentionEmpty.textContent = "No matches";
  mentionList.innerHTML = mentionItems
    .map(
      (it, i) =>
        '<button type="button" class="mention-item' +
        (i === mentionIndex ? " active" : "") +
        '" role="option" data-idx="' +
        i +
        '" aria-selected="' +
        (i === mentionIndex) +
        '">' +
        '<span class="mi-icon">' +
        icon(mentionIconName(it.icon)) +
        "</span>" +
        '<span class="mi-body">' +
        '<span class="mi-label">' +
        esc(it.label) +
        "</span>" +
        (it.description
          ? '<span class="mi-desc">' + esc(it.description) + "</span>"
          : "") +
        "</span>" +
        "</button>",
    )
    .join("");
  const active = mentionList.querySelector(".mention-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function requestMentionSearch(query) {
  const requestId = ++mentionRequestId;
  vscode.postMessage({ type: "searchMention", query: query || "", requestId });
}

function openMentionFromContext(ctx) {
  if (slashOpen) closeSlash();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  mentionOpen = true;
  mentionAtCtx = ctx;
  mentionIndex = 0;
  mentionPopover.hidden = false;
  mentionEmpty.hidden = false;
  mentionEmpty.textContent = "Searching…";
  mentionList.innerHTML = "";
  mentionTitle.textContent = "@" + (ctx.query || "…");
  if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
  mentionSearchTimer = setTimeout(() => {
    requestMentionSearch(ctx.query || "");
  }, 40);
}

function syncMentionFromComposer() {
  const text = composer.value;
  const cursor = composer.selectionStart || 0;
  const ctx = detectAtContext(text, cursor);
  if (!ctx) {
    if (mentionOpen) closeMention();
    return;
  }
  const same =
    mentionAtCtx &&
    mentionAtCtx.start === ctx.start &&
    mentionAtCtx.query === ctx.query;
  mentionAtCtx = ctx;
  if (!mentionOpen) {
    openMentionFromContext(ctx);
    return;
  }
  if (!same) {
    mentionIndex = 0;
    if (mentionSearchTimer) clearTimeout(mentionSearchTimer);
    mentionSearchTimer = setTimeout(() => {
      requestMentionSearch(ctx.query || "");
    }, 60);
    mentionTitle.textContent = "@" + (ctx.query || "…");
  }
}

function acceptMention(idx) {
  const item = mentionItems[idx];
  if (!item || !item.chip) return;
  const text = composer.value;
  const ctx =
    mentionAtCtx || detectAtContext(text, composer.selectionStart || 0);
  if (ctx) {
    const next = text.slice(0, ctx.start) + text.slice(ctx.end);
    composer.value = next;
    const pos = ctx.start;
    composer.setSelectionRange(pos, pos);
    autosizeComposer();
  }
  vscode.postMessage({ type: "pickMention", chip: item.chip });
  closeMention();
  composer.focus();
}

function moveMention(delta) {
  if (!mentionItems.length) return;
  mentionIndex =
    (mentionIndex + delta + mentionItems.length) % mentionItems.length;
  renderMentionList();
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function icon(name, extraClass) {
  return (
    '<i class="ti ti-' +
    name +
    (extraClass ? " " + extraClass : "") +
    '" aria-hidden="true"></i>'
  );
}

function toolIconName(t) {
  const s = ((t.kind || "") + " " + (t.title || "")).toLowerCase();
  if (/read|grep|search|glob|find|list/.test(s)) return "search";
  if (/edit|write|patch|replace|create.?file/.test(s)) return "pencil";
  if (/terminal|bash|shell|command|run/.test(s)) return "terminal-2";
  if (/web|fetch|http|browser/.test(s)) return "world";
  if (/task|subagent|agent/.test(s)) return "robot";
  if (/git/.test(s)) return "brand-git";
  return "tool";
}

function statusIcon(status) {
  const s = String(status || "").toLowerCase();
  if (/complet|success|done|ok/.test(s)) return icon("check");
  if (/fail|error/.test(s)) return icon("x");
  if (/run|progress|pending|in_progress/.test(s))
    return icon("loader", "ti-spin");
  return icon("circle-dashed");
}

function chipIcon(label) {
  if (String(label).startsWith("selection:")) return "highlight";
  if (String(label).startsWith("folder:")) return "folder";
  if (String(label).startsWith("file:")) return "file";
  return "paperclip";
}

function computeVirtualWindow(args) {
  const total = args.total,
    scrollTop = args.scrollTop,
    viewportHeight = args.viewportHeight;
  const estimatedRowHeight = args.estimatedRowHeight,
    overscan = args.overscan ?? 5;
  if (total <= 0 || estimatedRowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / estimatedRowHeight);
  const visible = Math.ceil(viewportHeight / estimatedRowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(total, first + visible + overscan),
  };
}

function shouldStickToBottom(
  scrollTop,
  scrollHeight,
  viewportHeight,
  thresholdPx,
) {
  thresholdPx = thresholdPx == null ? 48 : thresholdPx;
  return scrollTop + viewportHeight >= scrollHeight - thresholdPx;
}

function attachCopyButtons(root) {
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy-code")) return;
    const btn = document.createElement("button");
    btn.className = "copy-code";
    btn.type = "button";
    btn.title = "Copy";
    btn.setAttribute("aria-label", "Copy code");
    btn.innerHTML = icon("copy");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const code = pre.querySelector("code");
      const text = (
        (code && (code.innerText || code.textContent)) ||
        pre.innerText ||
        ""
      ).replace(/^\s+/, "");
      navigator.clipboard.writeText(text);
      if (typeof flashCopyBtn === "function") flashCopyBtn(btn);
    });
    pre.style.position = "relative";
    pre.prepend(btn);
  });
}

/**
 * Fill assistant text bubble. Prefers markdown HTML when present (including
 * while streaming). No stream text animation.
 */
function fillTextBubble(b, text, html, _opts) {
  const nextPlain = text || "";
  const key = html ? "h:" + html : "t:" + nextPlain;
  if (b.dataset.streamKey === key) return;
  b.dataset.streamKey = key;

  if (html) {
    b.innerHTML = html;
    attachCopyButtons(b);
  } else if (nextPlain) {
    b.textContent = nextPlain;
  } else {
    // Empty text segment — timeline-level shimmer covers the wait state.
    b.textContent = "";
  }
}

/** Skeleton shimmer while a live assistant has no timeline content yet. */
function renderStreamShimmer() {
  const el = document.createElement("div");
  el.className = "stream-shimmer";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML =
    '<div class="shimmer-line"></div>' +
    '<div class="shimmer-line"></div>' +
    '<div class="shimmer-line"></div>';
  return el;
}

/**
 * Show/hide skeleton shimmer on a timeline based on live stream + empty content.
 * Only the live tail assistant should shimmer; older bubbles stay settled.
 * Keeps an existing shimmer node so the CSS animation does not restart.
 */
function ensureStreamShimmer(timeline, m, isLive) {
  if (!timeline) return;
  const live = isLive === undefined ? isLiveStreamingAssistant(m) : !!isLive;
  const empty = visibleGroupedTimeline(m).length === 0;
  const existing = timeline.querySelector(":scope > .stream-shimmer");
  if (live && busy && empty) {
    // Drop any leftover content nodes; keep shimmer if already mounted.
    Array.from(timeline.children).forEach((child) => {
      if (!child.classList.contains("stream-shimmer")) child.remove();
    });
    if (!existing) timeline.appendChild(renderStreamShimmer());
    return;
  }
  if (existing) existing.remove();
}

/**
 * Only the latest running tool/group line gets shimmer (one live line, like Thinking…).
 * Scans top-level timeline children first, then nested tool-rows inside groups.
 */
function markLatestRunningTool(timeline) {
  if (!timeline) return;
  timeline.querySelectorAll(".tool-latest").forEach((el) => {
    el.classList.remove("tool-latest");
  });
  // Prefer the last top-level running tool or verb-group in stream order.
  const top = Array.from(timeline.children).filter(
    (el) =>
      (el.classList.contains("tool-row") &&
        el.classList.contains("tool-running")) ||
      (el.classList.contains("tool-group") && el.classList.contains("running")),
  );
  if (top.length) {
    top[top.length - 1].classList.add("tool-latest");
    return;
  }
  // Fallback: last nested running tool-row (e.g. only members updated).
  const nested = timeline.querySelectorAll(".tool-row.tool-running");
  if (nested.length) nested[nested.length - 1].classList.add("tool-latest");
}

/** TUI ThinkingBlock header: Thinking… / Thought for Xs / Thought */
function thoughtHeaderLabel(t) {
  if (t && t.label) return t.label;
  if (t && t.running) return "Thinking…";
  return "Thought";
}

/** Fill a thought <details> from a timeline thought segment. */
function fillThoughtBlock(d, t) {
  const running = !!(t && t.running);
  d.className = "thought" + (running ? " thought-running" : "");
  if (t && t.id) d.dataset.thoughtId = t.id;
  let summary = d.querySelector("summary");
  if (!summary) {
    summary = document.createElement("summary");
    d.appendChild(summary);
  }
  summary.innerHTML =
    icon("brain") +
    ' <span class="thought-label">' +
    esc(thoughtHeaderLabel(t)) +
    "</span>";
  let body = d.querySelector(".thought-body");
  if (!body) {
    body = document.createElement("div");
    body.className = "thought-body md";
    d.appendChild(body);
  } else {
    body.className = "thought-body md";
  }
  const bodyKey = t && t.html ? "h:" + t.html : "t:" + ((t && t.text) || "");
  if (body.dataset.streamKey !== bodyKey) {
    body.dataset.streamKey = bodyKey;
    if (t && t.html) {
      body.innerHTML = t.html;
    } else {
      body.textContent = (t && t.text) || "";
    }
  }
  if (running && body.scrollHeight > body.clientHeight) {
    body.scrollTop = body.scrollHeight;
  }
}

function renderThoughtRow(t, forceOpen) {
  const d = document.createElement("details");
  fillThoughtBlock(d, t);
  // Running → open; finished → collapsed unless user had it expanded (forceOpen).
  d.open = !!(t && t.running) || !!forceOpen;
  return d;
}

function renderToolRow(t, open) {
  const d = document.createElement("details");
  const running = isToolStatusRunning(t && t.status);
  d.className = "tool-row" + (running ? " tool-running" : "");
  d.dataset.toolId = t.id || "";
  d.dataset.streamKey =
    (t.status || "") +
    "|" +
    (t.title || "") +
    "|" +
    (t.input || "") +
    "|" +
    (t.output || "") +
    "|" +
    ((t.paths && t.paths.join(",")) || "");
  if (open) d.open = true;
  const summary = document.createElement("summary");
  // No disclosure arrow — click the row to expand detail (TUI-style fold).
  summary.innerHTML =
    '<span class="tool-ico">' +
    icon(toolIconName(t)) +
    "</span>" +
    '<span class="tool-title">' +
    esc(t.title || t.id || "tool") +
    "</span>" +
    '<span class="tool-status">' +
    statusIcon(t.status) +
    esc(t.status || "") +
    "</span>";
  d.appendChild(summary);

  const detail = document.createElement("div");
  detail.className = "tool-detail";
  const metaBits = [];
  if (t.kind) metaBits.push(esc(t.kind));
  if (t.status) metaBits.push(esc(t.status));
  if (metaBits.length) {
    const meta = document.createElement("div");
    meta.innerHTML = metaBits.join(" · ");
    detail.appendChild(meta);
  }
  if (t.paths && t.paths.length) {
    const paths = document.createElement("div");
    paths.className = "paths";
    paths.innerHTML = t.paths
      .map((p) => {
        const isEdit =
          /edit|write|patch|replace|create.?file|search_replace|apply/i.test(
            (t.kind || "") + " " + (t.title || ""),
          );
        return (
          '<a data-path="' +
          esc(p) +
          '" href="#">' +
          icon("file") +
          esc(p) +
          "</a>" +
          (isEdit
            ? '<button type="button" class="link" data-diff="' +
              esc(p) +
              '">' +
              icon("file-diff") +
              " Diff</button>"
            : "")
        );
      })
      .join("");
    detail.appendChild(paths);
  }
  // Input / output body — what TUI shows when a tool block is expanded.
  if (t.input) {
    const lab = document.createElement("div");
    lab.className = "tool-io-label";
    lab.textContent = "Input";
    detail.appendChild(lab);
    const pre = document.createElement("pre");
    pre.className = "tool-io";
    pre.textContent = t.input;
    detail.appendChild(pre);
  }
  if (t.output) {
    const lab = document.createElement("div");
    lab.className = "tool-io-label";
    lab.textContent = "Output";
    detail.appendChild(lab);
    const pre = document.createElement("pre");
    pre.className = "tool-io";
    pre.textContent = t.output;
    detail.appendChild(pre);
  }
  if (
    !t.input &&
    !t.output &&
    !(t.paths && t.paths.length) &&
    !metaBits.length
  ) {
    const empty = document.createElement("div");
    empty.className = "tool-meta";
    empty.textContent = "No extra details";
    detail.appendChild(empty);
  }
  d.appendChild(detail);
  return d;
}

/** Visible timeline items (empty text segments omitted, TUI-aligned). */
function visibleTimelineItems(m) {
  const items = Array.isArray(m.items) ? m.items : null;
  if (items && items.length) {
    const out = [];
    for (const item of items) {
      if (item.kind === "text") {
        if (!(item.text || item.html)) continue;
        out.push(item);
      } else if (item.kind === "tool" && item.tool) {
        out.push(item);
      } else if (item.kind === "thought" && item.thought) {
        out.push(item);
      }
    }
    return out;
  }
  // Legacy shape → synthetic items
  const out = [];
  if (m.html || m.text) {
    out.push({ kind: "text", text: m.text || "", html: m.html || "" });
  }
  if (m.tools && m.tools.length) {
    for (const t of m.tools) out.push({ kind: "tool", tool: t });
  }
  return out;
}

// ── Verb-group: consecutive toolcalls → "Read 2 files, Edited 4 files" ──
function classifyToolVerb(t) {
  const s = ((t && t.kind) || "") + " " + ((t && t.title) || "");
  const low = s.toLowerCase();
  if (/list.?dir|list_dir|listdir/.test(low)) return "dir";
  if (
    /search_replace|str_replace|apply.?patch|write.?file|edit|write|patch|create.?file|apply/.test(
      low,
    )
  ) {
    return "edit";
  }
  if (/grep|glob|search|find|rg\b|fuzzy/.test(low)) return "search";
  if (/read|open.?file|cat\b|view.?file/.test(low)) return "file";
  if (/web.?fetch|fetch|http|browser|web.?search|browse/.test(low))
    return "web";
  if (/terminal|bash|shell|command|execute|run_terminal|run /.test(low))
    return "command";
  if (/use.?tool|mcp|integration|call.?tool/.test(low)) return "mcp";
  return "other";
}

function isToolStatusRunning(status) {
  return /run|progress|pending|in_progress|start|stream/.test(
    String(status || "").toLowerCase(),
  );
}
function isToolStatusFailed(status) {
  return /fail|error|denied|cancel/.test(String(status || "").toLowerCase());
}

function formatToolVerbGroupLabel(tools) {
  const buckets = [];
  let running = false;
  let failed = 0;
  const verbTable = {
    file: ["Read", "Reading"],
    search: ["Searched", "Searching"],
    dir: ["Listed", "Listing"],
    edit: ["Edited", "Editing"],
    command: ["Ran", "Running"],
    web: ["Fetched", "Fetching"],
    mcp: ["Called", "Calling"],
    other: ["Ran", "Running"],
  };
  const nounTable = {
    file: ["file", "files"],
    search: ["pattern", "patterns"],
    dir: ["dir", "dirs"],
    edit: ["file", "files"],
    command: ["command", "commands"],
    web: ["website", "websites"],
    mcp: ["MCP tool", "MCP tools"],
    other: ["tool", "tools"],
  };
  for (const t of tools) {
    const kind = classifyToolVerb(t);
    const pos = buckets.findIndex((b) => b.kind === kind);
    if (pos < 0) buckets.push({ kind, count: 1 });
    else buckets[pos].count += 1;
    if (isToolStatusRunning(t.status)) running = true;
    if (isToolStatusFailed(t.status)) failed += 1;
  }
  const parts = buckets.map((b) => {
    const v = verbTable[b.kind] || verbTable.other;
    const n = nounTable[b.kind] || nounTable.other;
    const verb = running ? v[1] : v[0];
    const noun = b.count === 1 ? n[0] : n[1];
    return verb + " " + b.count + " " + noun;
  });
  let label = parts.join(", ");
  if (failed > 0) label += " · " + failed + " failed";
  return { label, running, failed };
}

/**
 * Fold consecutive tools into verb-groups (singleton stays flat).
 * Text / thought break the run.
 */
function groupConsecutiveTools(items) {
  const out = [];
  let run = [];
  function flush() {
    if (!run.length) return;
    if (run.length === 1) {
      out.push({ type: "tool", tool: run[0] });
    } else {
      const meta = formatToolVerbGroupLabel(run);
      const id =
        run
          .map((t) => t.id)
          .filter(Boolean)
          .join("|") || "tg-" + out.length;
      out.push({
        type: "toolGroup",
        group: {
          id,
          tools: run.slice(),
          label: meta.label,
          running: meta.running,
          failed: meta.failed,
        },
      });
    }
    run = [];
  }
  for (const item of items) {
    if (item.kind === "tool" && item.tool) {
      run.push(item.tool);
      continue;
    }
    flush();
    if (item.kind === "text") out.push({ type: "text", item });
    else if (item.kind === "thought") out.push({ type: "thought", item });
  }
  flush();
  return out;
}

function visibleGroupedTimeline(m) {
  return groupConsecutiveTools(visibleTimelineItems(m));
}

function timelineNodeSig(node) {
  if (node.type === "text") return "t";
  if (node.type === "tool" && node.tool) return "tool:" + (node.tool.id || "");
  if (node.type === "toolGroup" && node.group)
    return "tg:" + (node.group.id || "");
  if (node.type === "thought" && node.item && node.item.thought) {
    return "th:" + (node.item.thought.id || "");
  }
  return "?";
}

function domTimelineSig(timeline) {
  return Array.from(timeline.children)
    .filter((el) => !el.classList.contains("stream-shimmer"))
    .map((el) => {
      if (el.classList.contains("bubble")) return "t";
      if (el.classList.contains("tool-row"))
        return "tool:" + (el.dataset.toolId || "");
      if (el.classList.contains("tool-group"))
        return "tg:" + (el.dataset.groupId || "");
      if (el.classList.contains("thought"))
        return "th:" + (el.dataset.thoughtId || "");
      return "?";
    })
    .join("|");
}

function nodesTimelineSig(nodes) {
  return nodes.map(timelineNodeSig).join("|");
}

function renderToolGroup(group, openToolIds, openGroupIds) {
  const d = document.createElement("details");
  d.className =
    "tool-group" +
    (group.running ? " running" : "") +
    (group.failed ? " failed" : "");
  d.dataset.groupId = group.id || "";
  d.dataset.streamKey =
    group.label +
    "|" +
    group.running +
    "|" +
    group.failed +
    "|" +
    group.tools
      .map((t) => (t.id || "") + ":" + (t.status || "") + ":" + (t.title || ""))
      .join(";");
  const forceOpen =
    !!group.running ||
    (openGroupIds && openGroupIds.has(group.id)) ||
    (openToolIds && group.tools.some((t) => openToolIds.has(t.id)));
  if (forceOpen) d.open = true;
  const summary = document.createElement("summary");
  const first = group.tools[0];
  const ico = first ? toolIconName(first) : "tool";
  let statusHtml = "";
  if (group.running) {
    statusHtml = statusIcon("in_progress") + "…";
  } else if (group.failed) {
    statusHtml = statusIcon("failed") + esc(String(group.failed) + " failed");
  } else {
    statusHtml = statusIcon("completed");
  }
  summary.innerHTML =
    '<span class="tool-ico">' +
    icon(ico) +
    "</span>" +
    '<span class="tool-group-label">' +
    esc(group.label || "") +
    "</span>" +
    '<span class="tool-status">' +
    statusHtml +
    "</span>";
  d.appendChild(summary);
  const members = document.createElement("div");
  members.className = "tool-group-members";
  for (const t of group.tools) {
    const open = openToolIds && openToolIds.has(t.id);
    members.appendChild(renderToolRow(t, open));
  }
  d.appendChild(members);
  return d;
}

/** Build one timeline child for a grouped node. */
function renderTimelineNode(
  node,
  openToolIds,
  openThoughtIds,
  openGroupIds,
  streamText,
) {
  if (node.type === "text" && node.item) {
    const b = document.createElement("div");
    b.className = "bubble md";
    fillTextBubble(b, node.item.text || "", node.item.html || "", {
      stream: !!streamText,
    });
    return b;
  }
  if (node.type === "tool" && node.tool) {
    const open = openToolIds && openToolIds.has(node.tool.id);
    return renderToolRow(node.tool, open);
  }
  if (node.type === "toolGroup" && node.group) {
    return renderToolGroup(node.group, openToolIds, openGroupIds);
  }
  if (node.type === "thought" && node.item && node.item.thought) {
    const t = node.item.thought;
    const open = !!t.running || (openThoughtIds && openThoughtIds.has(t.id));
    return renderThoughtRow(t, open);
  }
  return null;
}

/**
 * Patch timeline in place when structure matches — only last text/thought/tool
 * content updates. Avoids full DOM replace flicker while tokens stream.
 * Returns true if patched; false if caller should rebuild.
 */
function patchTimelineInPlace(
  timeline,
  m,
  openToolIds,
  openThoughtIds,
  openGroupIds,
) {
  const nodes = visibleGroupedTimeline(m);
  if (nodesTimelineSig(nodes) !== domTimelineSig(timeline)) return false;
  const contentChildren = Array.from(timeline.children).filter(
    (el) => !el.classList.contains("stream-shimmer"),
  );

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const el = contentChildren[i];
    if (!el) return false;
    if (node.type === "text" && node.item) {
      // Only the live tail text node streams per-character.
      const streamTail = busy && i === nodes.length - 1;
      fillTextBubble(el, node.item.text || "", node.item.html || "", {
        stream: streamTail,
      });
    } else if (node.type === "tool" && node.tool) {
      const t = node.tool;
      const key =
        (t.status || "") +
        "|" +
        (t.title || "") +
        "|" +
        (t.input || "") +
        "|" +
        (t.output || "") +
        "|" +
        ((t.paths && t.paths.join(",")) || "");
      if (el.dataset.streamKey !== key) {
        const wasOpen = el.open || (openToolIds && openToolIds.has(t.id));
        const next = renderToolRow(t, wasOpen);
        next.dataset.streamKey = key;
        el.replaceWith(next);
      }
    } else if (node.type === "toolGroup" && node.group) {
      const g = node.group;
      const key =
        g.label +
        "|" +
        g.running +
        "|" +
        g.failed +
        "|" +
        g.tools
          .map(
            (t) =>
              (t.id || "") + ":" + (t.status || "") + ":" + (t.title || ""),
          )
          .join(";");
      if (el.dataset.streamKey !== key) {
        const wasOpen =
          el.open || (openGroupIds && openGroupIds.has(g.id)) || !!g.running;
        const next = renderToolGroup(g, openToolIds, openGroupIds);
        if (wasOpen) next.open = true;
        next.dataset.streamKey = key;
        el.replaceWith(next);
      }
    } else if (node.type === "thought" && node.item && node.item.thought) {
      const th = node.item.thought;
      const forceOpen =
        !!th.running ||
        (openThoughtIds && openThoughtIds.has(th.id)) ||
        el.open;
      fillThoughtBlock(el, th);
      el.open = forceOpen;
    }
  }
  timeline.classList.add("stream-settled");
  markLatestRunningTool(timeline);
  return true;
}

/** Build timeline nodes (thoughts + text + tools) in stream order. */
function renderAssistantTimeline(m, openToolIds, openThoughtIds, openGroupIds) {
  const timeline = document.createElement("div");
  timeline.className = "assistant-timeline";
  const live = isLiveStreamingAssistant(m);
  const nodes = visibleGroupedTimeline(m);
  for (let i = 0; i < nodes.length; i++) {
    const streamText =
      live && i === nodes.length - 1 && nodes[i].type === "text";
    const el = renderTimelineNode(
      nodes[i],
      openToolIds,
      openThoughtIds,
      openGroupIds,
      streamText,
    );
    if (el) timeline.appendChild(el);
  }
  // Waiting for first token / thought / tool — skeleton only on live tail.
  ensureStreamShimmer(timeline, m, live);
  markLatestRunningTool(timeline);
  // After first frame, only newly appended blocks (class tl-new) animate.
  requestAnimationFrame(() => timeline.classList.add("stream-settled"));
  return timeline;
}

/**
 * When structure only grows at the end (new top-level nodes), update prefix
 * content in place and append new nodes. Group fold (1 tool → "Read 2 files")
 * changes the prefix signature, so the caller rebuilds instead.
 */
function appendTimelineDelta(
  timeline,
  m,
  openToolIds,
  openThoughtIds,
  openGroupIds,
) {
  const nodes = visibleGroupedTimeline(m);
  // Ignore shimmer placeholder when measuring existing DOM length / signature.
  const contentChildren = Array.from(timeline.children).filter(
    (el) => !el.classList.contains("stream-shimmer"),
  );
  const domCount = contentChildren.length;
  if (domCount === 0 || nodes.length <= domCount) return false;
  const prefixNodes = nodes.slice(0, domCount);
  if (nodesTimelineSig(prefixNodes) !== domTimelineSig(timeline)) return false;

  // Patch prefix content without requiring full-list signature match.
  for (let i = 0; i < prefixNodes.length; i++) {
    const node = prefixNodes[i];
    const el = contentChildren[i];
    if (!el) return false;
    if (node.type === "text" && node.item) {
      // Prefix nodes are never the growing tail when we append after them.
      fillTextBubble(el, node.item.text || "", node.item.html || "", {
        stream: false,
      });
    } else if (node.type === "tool" && node.tool) {
      const t = node.tool;
      const key =
        (t.status || "") +
        "|" +
        (t.title || "") +
        "|" +
        (t.input || "") +
        "|" +
        (t.output || "") +
        "|" +
        ((t.paths && t.paths.join(",")) || "");
      if (el.dataset.streamKey !== key) {
        const wasOpen = el.open || (openToolIds && openToolIds.has(t.id));
        const next = renderToolRow(t, wasOpen);
        next.dataset.streamKey = key;
        el.replaceWith(next);
      }
    } else if (node.type === "toolGroup" && node.group) {
      const g = node.group;
      const key =
        g.label +
        "|" +
        g.running +
        "|" +
        g.failed +
        "|" +
        g.tools
          .map(
            (t) =>
              (t.id || "") + ":" + (t.status || "") + ":" + (t.title || ""),
          )
          .join(";");
      if (el.dataset.streamKey !== key) {
        const wasOpen =
          el.open || (openGroupIds && openGroupIds.has(g.id)) || !!g.running;
        const next = renderToolGroup(g, openToolIds, openGroupIds);
        if (wasOpen) next.open = true;
        next.dataset.streamKey = key;
        el.replaceWith(next);
      }
    } else if (node.type === "thought" && node.item && node.item.thought) {
      const th = node.item.thought;
      const forceOpen =
        !!th.running ||
        (openThoughtIds && openThoughtIds.has(th.id)) ||
        el.open;
      fillThoughtBlock(el, th);
      el.open = forceOpen;
    }
  }
  // Drop shimmer before appending real content so it never sits under nodes.
  timeline
    .querySelectorAll(":scope > .stream-shimmer")
    .forEach((el) => el.remove());
  for (let i = domCount; i < nodes.length; i++) {
    const streamText =
      busy && i === nodes.length - 1 && nodes[i].type === "text";
    const el = renderTimelineNode(
      nodes[i],
      openToolIds,
      openThoughtIds,
      openGroupIds,
      streamText,
    );
    if (!el) continue;
    el.classList.add("tl-new");
    timeline.appendChild(el);
  }
  timeline.classList.add("stream-settled");
  markLatestRunningTool(timeline);
  return true;
}

function collectOpenToolIds(wrap) {
  const ids = new Set();
  wrap.querySelectorAll("details.tool-row[open]").forEach((el) => {
    const id = el.dataset.toolId;
    if (id) ids.add(id);
  });
  return ids;
}

function collectOpenThoughtIds(wrap) {
  const ids = new Set();
  wrap.querySelectorAll("details.thought[open]").forEach((el) => {
    const id = el.dataset.thoughtId;
    if (id) ids.add(id);
  });
  return ids;
}

function collectOpenGroupIds(wrap) {
  const ids = new Set();
  wrap.querySelectorAll("details.tool-group[open]").forEach((el) => {
    const id = el.dataset.groupId;
    if (id) ids.add(id);
  });
  return ids;
}

/**
 * Plain text for copy. Prefer live allMessages entry — streaming patches the
 * DOM/timeline without remounting actions, so the closed-over m is often the
 * empty optimistic assistant from first paint.
 */
function messageCopyPlain(m) {
  if (!m) return "";
  if (m.type === "user" || m.type === "system") return (m.text || "").trim();
  if (m.type === "assistant") {
    if (m.text && String(m.text).trim()) return String(m.text);
    const items = Array.isArray(m.items) ? m.items : [];
    const parts = [];
    for (const it of items) {
      if (it && it.kind === "text" && it.text) parts.push(it.text);
    }
    return parts.join("\n\n").trim();
  }
  return "";
}

/** Visible text from rendered assistant bubbles (fallback when model data is stale). */
function messageCopyFromDom(wrap) {
  if (!wrap) return "";
  if (wrap.classList.contains("user") || wrap.classList.contains("system")) {
    const b = wrap.querySelector(":scope > .bubble");
    return ((b && (b.innerText || b.textContent)) || "").trim();
  }
  // Assistant: text bubbles only (skip tools / thoughts).
  const bubbles = wrap.querySelectorAll(
    ":scope > .assistant-timeline > .bubble.md, :scope > .bubble.md",
  );
  const parts = [];
  bubbles.forEach((b) => {
    // Exclude code-block copy buttons so icon/label never pollutes plain text.
    const clone = b.cloneNode(true);
    clone.querySelectorAll(".copy-code").forEach((el) => el.remove());
    let t = (clone.innerText || clone.textContent || "").trim();
    if (t) parts.push(t);
  });
  return parts.join("\n\n").trim();
}

function flashCopyBtn(copyBtn) {
  copyBtn.classList.add("copied");
  copyBtn.innerHTML = icon("check");
  setTimeout(() => {
    copyBtn.classList.remove("copied");
    copyBtn.innerHTML = icon("copy");
  }, 1200);
}

function renderMsgActions(m) {
  const bar = document.createElement("div");
  bar.className = "msg-actions";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Message actions");

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "msg-act-copy msg-act-icon";
  copyBtn.title = "Copy";
  copyBtn.setAttribute("aria-label", "Copy message");
  copyBtn.innerHTML = icon("copy");
  copyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wrap = copyBtn.closest(".msg");
    const live =
      (m && m.id && allMessages.find((x) => x && x.id === m.id)) || m;
    let text = messageCopyPlain(live);
    if (!text) text = messageCopyFromDom(wrap);
    if (!text) return;
    // Host clipboard is reliable in VS Code webviews; navigator is best-effort.
    vscode.postMessage({ type: "copyText", text: text });
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {
        /* host already has it */
      });
    }
    flashCopyBtn(copyBtn);
  });
  bar.appendChild(copyBtn);

  if (m.type === "user") {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "msg-act-edit msg-act-icon";
    editBtn.title = "Edit and resubmit";
    editBtn.setAttribute("aria-label", "Edit message");
    editBtn.innerHTML = icon("pencil");
    editBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Resolve from allMessages so we always use the live list entry.
      const live =
        (m &&
          m.id &&
          allMessages.find((x) => x && x.id === m.id && x.type === "user")) ||
        m;
      enterUserMessageEdit(live);
    });
    bar.appendChild(editBtn);

    if (typeof m.promptIndex === "number") {
      const rewindBtn = document.createElement("button");
      rewindBtn.type = "button";
      rewindBtn.className = "msg-act-rewind msg-act-icon";
      rewindBtn.title = "Rewind to this turn";
      rewindBtn.setAttribute("aria-label", "Rewind to this turn");
      rewindBtn.innerHTML = icon("arrow-back-up");
      rewindBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        vscode.postMessage({
          type: "sessionRewindFromMessage",
          promptIndex: m.promptIndex,
        });
      });
      bar.appendChild(rewindBtn);
    }
  }
  return bar;
}

// ── Session rewind panel (multi-step; distinct from edit-mode popover) ──
function setSessionRewindOpen(open) {
  sessionRewindOpen = !!open;
  if (appRoot) {
    appRoot.classList.toggle("session-rewind-open", sessionRewindOpen);
  }
  if (sessionRewindPanel) {
    sessionRewindPanel.hidden = !sessionRewindOpen;
  }
}

function closeSessionRewindPanel() {
  setSessionRewindOpen(false);
  sessionRewindPhase = "points";
  sessionRewindIndex = 0;
  sessionRewindItems = [];
  if (sessionRewindBody) sessionRewindBody.innerHTML = "";
  if (sessionRewindFoot) sessionRewindFoot.hidden = true;
  if (sessionRewindBack) sessionRewindBack.hidden = true;
  if (sessionRewindBadge) {
    sessionRewindBadge.hidden = true;
    sessionRewindBadge.textContent = "";
  }
  if (sessionRewindTitle) sessionRewindTitle.textContent = "Rewind";
}

function sessionRewindSetActive(idx) {
  sessionRewindIndex = idx;
  if (!sessionRewindBody) return;
  const buttons = sessionRewindBody.querySelectorAll(".session-rewind-item");
  buttons.forEach((btn, i) => {
    btn.classList.toggle("active", i === idx);
    btn.setAttribute("aria-selected", i === idx ? "true" : "false");
  });
  const active = sessionRewindBody.querySelector(".session-rewind-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function renderSessionRewindPoints(points, selectPromptIndex) {
  sessionRewindPhase = "points";
  sessionRewindItems = Array.isArray(points) ? points : [];
  if (sessionRewindTitle) sessionRewindTitle.textContent = "Rewind to turn";
  if (sessionRewindBadge) {
    sessionRewindBadge.hidden = false;
    sessionRewindBadge.textContent =
      sessionRewindItems.length +
      " point" +
      (sessionRewindItems.length === 1 ? "" : "s");
  }
  if (sessionRewindBack) sessionRewindBack.hidden = true;
  if (sessionRewindFoot) sessionRewindFoot.hidden = true;
  if (!sessionRewindBody) return;
  if (!sessionRewindItems.length) {
    sessionRewindBody.innerHTML =
      '<div class="session-rewind-status">No rewind points yet.</div>';
    return;
  }
  let active = 0;
  if (typeof selectPromptIndex === "number") {
    const i = sessionRewindItems.findIndex(
      (p) => p.promptIndex === selectPromptIndex,
    );
    if (i >= 0) active = i;
  }
  sessionRewindBody.innerHTML = sessionRewindItems
    .map(
      (p, i) =>
        '<button type="button" class="session-rewind-item' +
        (i === active ? " active" : "") +
        '" data-sr-point="' +
        p.promptIndex +
        '" role="option" aria-selected="' +
        (i === active ? "true" : "false") +
        '">' +
        '<span class="sr-label">' +
        esc(p.label || "#" + p.promptIndex) +
        "</span>" +
        '<span class="sr-detail">' +
        esc(p.description || "") +
        "</span>" +
        "</button>",
    )
    .join("");
  sessionRewindSetActive(active);
}

function renderSessionRewindModes(point, modes) {
  sessionRewindPhase = "mode";
  sessionRewindItems = Array.isArray(modes) ? modes : [];
  if (sessionRewindTitle) {
    sessionRewindTitle.textContent =
      "Rewind mode · #" +
      (point && point.promptIndex != null ? point.promptIndex : "?");
  }
  if (sessionRewindBadge) {
    sessionRewindBadge.hidden = false;
    sessionRewindBadge.textContent =
      point && point.hasFileChanges ? "files" : "chat";
  }
  if (sessionRewindBack) sessionRewindBack.hidden = false;
  if (sessionRewindFoot) sessionRewindFoot.hidden = true;
  if (!sessionRewindBody) return;
  sessionRewindBody.innerHTML = sessionRewindItems
    .map(
      (m, i) =>
        '<button type="button" class="session-rewind-item' +
        (i === 0 ? " active" : "") +
        '" data-sr-mode="' +
        esc(m.mode) +
        '" role="option" aria-selected="' +
        (i === 0 ? "true" : "false") +
        '">' +
        '<span class="sr-label">' +
        esc(m.label) +
        "</span>" +
        '<span class="sr-detail">' +
        esc(m.detail || "") +
        "</span>" +
        "</button>",
    )
    .join("");
  sessionRewindSetActive(0);
}

function renderSessionRewindConfirm(msg) {
  sessionRewindPhase = "confirm";
  sessionRewindItems = [];
  if (sessionRewindTitle) sessionRewindTitle.textContent = "Confirm rewind";
  if (sessionRewindBadge) {
    sessionRewindBadge.hidden = false;
    sessionRewindBadge.textContent = msg.force ? "force" : "preview";
  }
  if (sessionRewindBack) sessionRewindBack.hidden = false;
  if (sessionRewindFoot) sessionRewindFoot.hidden = false;
  if (sessionRewindConfirmBtn) {
    sessionRewindConfirmBtn.textContent = msg.force ? "Force rewind" : "Rewind";
  }
  if (!sessionRewindBody) return;
  let html =
    '<div class="session-rewind-confirm-summary">' +
    esc(msg.title || "Confirm rewind") +
    "</div>";
  const conflicts = Array.isArray(msg.conflicts) ? msg.conflicts : [];
  const files = Array.isArray(msg.files) ? msg.files : [];
  const rows = conflicts.length
    ? conflicts.map(
        (c) =>
          '<li><span class="sr-file-name" title="' +
          esc(c.path || "") +
          '">' +
          esc(c.name || c.path || "") +
          '</span><span class="sr-file-tag">' +
          esc(c.label || "conflict") +
          "</span></li>",
      )
    : files.map(
        (f) =>
          '<li><span class="sr-file-name" title="' +
          esc(f.path || "") +
          '">' +
          esc(f.name || f.path || "") +
          "</span></li>",
      );
  if (rows.length) {
    html += '<ul class="session-rewind-file-list">' + rows.join("") + "</ul>";
  }
  if (msg.moreFiles > 0) {
    html +=
      '<div class="session-rewind-status">…and ' +
      msg.moreFiles +
      " more</div>";
  }
  sessionRewindBody.innerHTML = html;
}

function renderSessionRewindBusy(message) {
  sessionRewindPhase = "busy";
  sessionRewindItems = [];
  if (sessionRewindTitle) sessionRewindTitle.textContent = "Rewind";
  if (sessionRewindBack) sessionRewindBack.hidden = true;
  if (sessionRewindFoot) sessionRewindFoot.hidden = true;
  if (sessionRewindBody) {
    sessionRewindBody.innerHTML =
      '<div class="session-rewind-status">' +
      esc(message || "Working…") +
      "</div>";
  }
}

function renderSessionRewindError(error) {
  sessionRewindPhase = "error";
  sessionRewindItems = [];
  if (sessionRewindTitle) sessionRewindTitle.textContent = "Rewind failed";
  if (sessionRewindBack) sessionRewindBack.hidden = false;
  if (sessionRewindFoot) sessionRewindFoot.hidden = true;
  if (sessionRewindBody) {
    sessionRewindBody.innerHTML =
      '<div class="session-rewind-status error">' +
      esc(error || "Unknown error") +
      "</div>";
  }
}

function handleSessionRewindMessage(msg) {
  if (!msg || msg.type !== "sessionRewind") return;
  const phase = msg.phase || "close";
  if (phase === "close") {
    closeSessionRewindPanel();
    return;
  }
  setSessionRewindOpen(true);
  if (phase === "points") {
    renderSessionRewindPoints(msg.points, msg.selectPromptIndex);
  } else if (phase === "mode") {
    renderSessionRewindModes(msg.point, msg.modes);
  } else if (phase === "confirm") {
    renderSessionRewindConfirm(msg);
  } else if (phase === "busy") {
    renderSessionRewindBusy(msg.message);
  } else if (phase === "error") {
    renderSessionRewindError(msg.error);
  }
}

function sessionRewindAcceptActive() {
  if (sessionRewindPhase === "confirm") {
    vscode.postMessage({ type: "sessionRewindConfirm" });
    return;
  }
  if (sessionRewindPhase === "points") {
    const item = sessionRewindItems[sessionRewindIndex];
    if (item && typeof item.promptIndex === "number") {
      vscode.postMessage({
        type: "sessionRewindPick",
        promptIndex: item.promptIndex,
      });
    }
    return;
  }
  if (sessionRewindPhase === "mode") {
    const item = sessionRewindItems[sessionRewindIndex];
    if (item && item.mode) {
      vscode.postMessage({ type: "sessionRewindMode", mode: item.mode });
    }
  }
}

function sessionRewindMove(delta) {
  if (sessionRewindPhase !== "points" && sessionRewindPhase !== "mode") {
    return;
  }
  if (!sessionRewindItems.length) return;
  const next =
    (sessionRewindIndex + delta + sessionRewindItems.length) %
    sessionRewindItems.length;
  sessionRewindSetActive(next);
}

if (sessionRewindBody) {
  sessionRewindBody.addEventListener("click", (e) => {
    const pointBtn = e.target.closest("[data-sr-point]");
    if (pointBtn) {
      e.preventDefault();
      vscode.postMessage({
        type: "sessionRewindPick",
        promptIndex: Number(pointBtn.getAttribute("data-sr-point")),
      });
      return;
    }
    const modeBtn = e.target.closest("[data-sr-mode]");
    if (modeBtn) {
      e.preventDefault();
      vscode.postMessage({
        type: "sessionRewindMode",
        mode: modeBtn.getAttribute("data-sr-mode"),
      });
    }
  });
}
if (sessionRewindClose) {
  sessionRewindClose.addEventListener("click", () =>
    vscode.postMessage({ type: "sessionRewindCancel" }),
  );
}
if (sessionRewindBack) {
  sessionRewindBack.addEventListener("click", () =>
    vscode.postMessage({ type: "sessionRewindBack" }),
  );
}
if (sessionRewindCancelBtn) {
  sessionRewindCancelBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "sessionRewindCancel" }),
  );
}
if (sessionRewindConfirmBtn) {
  sessionRewindConfirmBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "sessionRewindConfirm" }),
  );
}

/**
 * Composer-based edit of a previous user prompt (TUI inline-edit intent).
 * Click Edit → draft lands in composer; Send opens rewind-mode popover.
 */
let pendingEdit = null; // { id, promptIndex?, original }
let rewindOpen = false;
let rewindIndex = 0;
const REWIND_MODES = [
  {
    mode: "all",
    label: "Both conversation and file changes",
    detail: "Rewind chat and revert file snapshots from this prompt",
  },
  {
    mode: "conversation_only",
    label: "Conversation only",
    detail: "Rewind chat only — leave workspace files as they are",
  },
];

const editBanner = document.getElementById("edit-banner");
const editBannerCancel = document.getElementById("edit-banner-cancel");
const rewindPopover = document.getElementById("rewind-popover");
const rewindList = document.getElementById("rewind-list");

function updateEditBanner() {
  if (!editBanner) return;
  editBanner.hidden = !pendingEdit;
  if (pendingEdit) {
    composer.placeholder = "Edit message… (Enter resubmit · Esc cancel)";
  } else {
    syncComposerPlaceholder();
  }
  updateSendStopButton();
}

function clearPendingEdit(opts) {
  const keepText = !!(opts && opts.keepText);
  pendingEdit = null;
  closeRewindPopover();
  if (!keepText) {
    // Leave composer alone if caller already set draft / cleared it.
  }
  updateEditBanner();
}

function cancelPendingEdit() {
  if (!pendingEdit) return;
  pendingEdit = null;
  closeRewindPopover();
  composer.value = "";
  autosizeComposer();
  updateEditBanner();
  renderMessages(allMessages, { force: true });
  composer.focus();
}

function enterUserMessageEdit(m) {
  if (!m || m.type !== "user" || !m.id) return;
  if (mentionOpen) closeMention();
  if (slashOpen) closeSlash();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  closeRewindPopover();
  pendingEdit = {
    id: m.id,
    promptIndex: typeof m.promptIndex === "number" ? m.promptIndex : undefined,
    original: (m.text || "").trim(),
  };
  composer.value = m.text || "";
  autosizeComposer();
  updateEditBanner();
  // Highlight source bubble
  renderMessages(allMessages, { force: true });
  composer.focus();
  const len = composer.value.length;
  try {
    composer.setSelectionRange(len, len);
  } catch (_) {
    /* ignore */
  }
}

function restoreEditComposer(id, text) {
  const draft = text != null ? String(text) : "";
  const src = allMessages.find((m) => m && m.id === id && m.type === "user");
  pendingEdit = {
    id: id,
    promptIndex:
      src && typeof src.promptIndex === "number" ? src.promptIndex : undefined,
    original: src ? (src.text || "").trim() : "",
  };
  composer.value = draft;
  autosizeComposer();
  updateEditBanner();
  composer.focus();
}

function closeRewindPopover() {
  rewindOpen = false;
  rewindIndex = 0;
  if (rewindPopover) rewindPopover.hidden = true;
}

function renderRewindList() {
  if (!rewindList) return;
  rewindList.innerHTML = REWIND_MODES.map(
    (item, i) =>
      '<button type="button" class="rewind-item' +
      (i === rewindIndex ? " active" : "") +
      '" data-rewind-idx="' +
      i +
      '" role="option" aria-selected="' +
      (i === rewindIndex ? "true" : "false") +
      '">' +
      '<span class="rewind-label">' +
      esc(item.label) +
      "</span>" +
      '<span class="rewind-detail">' +
      esc(item.detail) +
      "</span>" +
      "</button>",
  ).join("");
  const active = rewindList.querySelector(".rewind-item.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function openRewindPopover() {
  if (!pendingEdit) return;
  if (mentionOpen) closeMention();
  if (slashOpen) closeSlash();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  rewindOpen = true;
  rewindIndex = 0;
  if (rewindPopover) rewindPopover.hidden = false;
  renderRewindList();
}

function moveRewind(delta) {
  if (!REWIND_MODES.length) return;
  rewindIndex =
    (rewindIndex + delta + REWIND_MODES.length) % REWIND_MODES.length;
  renderRewindList();
}

function acceptRewind(idx) {
  const item = REWIND_MODES[idx];
  if (!item || !pendingEdit) return;
  const text = composer.value.trim();
  if (!text) {
    closeRewindPopover();
    return;
  }
  const pe = pendingEdit;
  closeRewindPopover();
  pendingEdit = null;
  updateEditBanner();
  composer.value = "";
  autosizeComposer();
  updateSendStopButton();
  renderMessages(allMessages, { force: true });
  vscode.postMessage({
    type: "editMessage",
    id: pe.id,
    text: text,
    promptIndex: pe.promptIndex,
    mode: item.mode,
  });
}

/** True when a dismissible (non-modal) popover is open. */
function anyDropdownOpen() {
  return !!(modelOpen || effortOpen || slashOpen || mentionOpen || rewindOpen);
}

/**
 * Close popovers when clicking outside them.
 * - Model / effort / slash / mention / rewind: dismiss
 * - Permission / question: modal — only cancel if click is fully outside
 *   those dialogs (not on their chrome)
 * - Toggle buttons (#btn-model / #btn-effort) are excluded so click can toggle
 * - Composer keeps slash/mention open (filter still driven by typing)
 */
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!anyDropdownOpen() && !permissionOpen && !questionOpen) return;
    const t = e.target;
    if (!t || !t.closest) return;

    // Inside any popover surface — leave open.
    if (
      t.closest(
        "#model-popover, #effort-popover, #slash-popover, #mention-popover, " +
          "#rewind-popover, #permission-popover, #question-popover",
      )
    ) {
      return;
    }

    // Model/effort toggle buttons: their click handlers own open/close.
    if (t.closest("#btn-model, #btn-effort")) {
      return;
    }

    // Composer / shell: dismiss model/effort/rewind but keep slash/mention.
    if (t.closest("#composer, .composer-shell, #edit-banner")) {
      if (modelOpen) closeModelPopover();
      if (effortOpen) closeEffortPopover();
      if (rewindOpen) closeRewindPopover();
      return;
    }

    if (modelOpen) closeModelPopover();
    if (effortOpen) closeEffortPopover();
    if (slashOpen) closeSlash();
    if (mentionOpen) closeMention();
    if (rewindOpen) closeRewindPopover();

    // Modal dialogs: outside click = cancel (same as Esc).
    if (permissionOpen) {
      closePermissionPopover({ outcome: "cancelled" });
    }
    if (questionOpen) {
      closeQuestionPopover({ outcome: "cancelled" });
    }
  },
  true,
);

/** Send path when a composer edit is pending: open mode popover or no-op. */
function trySubmitPendingEdit() {
  if (!pendingEdit) return false;
  const text = composer.value.trim();
  if (!text) return true; // swallow empty
  if (text === pendingEdit.original) {
    // Unchanged → just cancel edit mode (TUI Enter-with-same exits).
    cancelPendingEdit();
    return true;
  }
  openRewindPopover();
  return true;
}

if (editBannerCancel) {
  editBannerCancel.addEventListener("click", () => cancelPendingEdit());
}
if (rewindList) {
  rewindList.addEventListener("mousedown", (e) => e.preventDefault());
  rewindList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-rewind-idx]");
    if (!btn) return;
    acceptRewind(Number(btn.getAttribute("data-rewind-idx")));
  });
}

/** True when this assistant is the live streaming tail (last assistant while busy). */
function isLiveStreamingAssistant(m) {
  if (!busy || !m || m.type !== "assistant") return false;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const x = allMessages[i];
    if (x && x.type === "assistant") {
      return x.id === m.id;
    }
  }
  return false;
}

function renderOneMessage(m, isNew) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + m.type + (isNew ? " msg-enter" : "");
  wrap.dataset.msgId = m.id || "";
  if (m.type === "user" && typeof m.promptIndex === "number") {
    wrap.dataset.promptIndex = String(m.promptIndex);
  }
  if (isLiveStreamingAssistant(m)) {
    wrap.classList.add("streaming");
  }
  if (m.type === "user") {
    if (m.images && m.images.length) {
      wrap.appendChild(renderMsgImages(m.images));
    }
    if (m.chips && m.chips.length) {
      const chips = document.createElement("div");
      chips.className = "chips";
      chips.innerHTML = m.chips
        .map((c) => {
          const label = String(c || "");
          return (
            '<span class="chip" title="' +
            escAttr(label) +
            '">' +
            icon(chipIcon(label)) +
            '<span class="chip-label">' +
            esc(label) +
            "</span></span>"
          );
        })
        .join("");
      wrap.appendChild(chips);
    }
    if (pendingEdit && m.id === pendingEdit.id) {
      wrap.classList.add("editing");
    }
    const b = document.createElement("div");
    // Prefer host-sanitized markdown HTML (same pipeline as assistant).
    b.className = "bubble" + (m.html ? " md" : "");
    fillTextBubble(b, m.text || "", m.html || "");
    wrap.appendChild(b);
    wrap.appendChild(renderMsgActions(m));
  } else if (m.type === "assistant") {
    // Thoughts live on the timeline with tools/text (TUI scrollback order).
    wrap.appendChild(renderAssistantTimeline(m, null, null, null));
    wrap.appendChild(renderMsgActions(m));
  } else {
    // System lifecycle/info: full-width dashed separator with text in the middle.
    const b = document.createElement("div");
    b.className = "bubble system-sep";
    const left = document.createElement("span");
    left.className = "system-sep-line";
    left.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "system-sep-text";
    text.textContent = m.text || "";
    const right = document.createElement("span");
    right.className = "system-sep-line";
    right.setAttribute("aria-hidden", "true");
    b.appendChild(left);
    b.appendChild(text);
    b.appendChild(right);
    wrap.appendChild(b);
  }
  return wrap;
}

/** Same length + same prefix ids; only last assistant streams — patch that node. */
function isStreamingTailUpdate(prev, next) {
  if (!next.length || prev.length !== next.length) return false;
  const last = next[next.length - 1];
  if (!last || last.type !== "assistant") return false;
  for (let i = 0; i < next.length - 1; i++) {
    const a = prev[i],
      b = next[i];
    if (!a || !b || a.id !== b.id || a.type !== b.type) return false;
  }
  const prevLast = prev[prev.length - 1];
  return !!(
    prevLast &&
    prevLast.id === last.id &&
    prevLast.type === "assistant"
  );
}

/** Message ids already mounted — used so re-renders don't re-play enter anim. */
const seenMsgIds = new Set();
let stickScrollRaf = 0;
let stickScrollWanted = false;

/**
 * Follow stream to bottom without fighting the browser.
 * rAF-coalesced; small growth snaps, large jumps ease via scrollTo.
 */
function requestStickScroll(opts) {
  const force = !!(opts && opts.force);
  const smooth = !!(opts && opts.smooth);
  if (!force) {
    const near = shouldStickToBottom(
      messagesEl.scrollTop,
      messagesEl.scrollHeight,
      messagesEl.clientHeight,
      busy ? 96 : 48,
    );
    if (!near) return;
  }
  stickScrollWanted = true;
  if (stickScrollRaf) return;
  stickScrollRaf = requestAnimationFrame(() => {
    stickScrollRaf = 0;
    if (!stickScrollWanted) return;
    stickScrollWanted = false;
    const max = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight);
    const delta = max - messagesEl.scrollTop;
    if (delta <= 1) return;
    if (
      smooth &&
      delta > 80 &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      messagesEl.scrollTo({ top: max, behavior: "smooth" });
    } else {
      messagesEl.scrollTop = max;
    }
  });
}

function patchLastAssistant(m) {
  // Prefer data-msg-id; fall back to last .msg.assistant in the list.
  let wrap = m.id
    ? messagesEl.querySelector(
        '.msg.assistant[data-msg-id="' + CSS.escape(m.id) + '"]',
      )
    : null;
  if (!wrap) {
    const nodes = messagesEl.querySelectorAll(".msg.assistant");
    wrap = nodes.length ? nodes[nodes.length - 1] : null;
  }
  if (!wrap) return false;

  // Preserve which tool/thought rows the user has expanded across stream patches.
  const openToolIds = collectOpenToolIds(wrap);
  const openThoughtIds = collectOpenThoughtIds(wrap);
  const openGroupIds = collectOpenGroupIds(wrap);

  // Drop legacy top-level thought (pre-timeline); everything is in the timeline now.
  wrap
    .querySelectorAll(":scope > details.thought")
    .forEach((el) => el.remove());

  const live = isLiveStreamingAssistant(m);
  wrap.classList.toggle("streaming", live);

  const oldTimeline = wrap.querySelector(":scope > .assistant-timeline");
  if (oldTimeline) {
    // Empty live assistant → shimmer only (avoid thrashing rebuilds).
    if (visibleGroupedTimeline(m).length === 0) {
      ensureStreamShimmer(oldTimeline, m, live);
      markLatestRunningTool(oldTimeline);
      return true;
    }
    // Real content arriving — drop shimmer, then patch/append/rebuild.
    oldTimeline
      .querySelectorAll(":scope > .stream-shimmer")
      .forEach((el) => el.remove());
    if (
      patchTimelineInPlace(
        oldTimeline,
        m,
        openToolIds,
        openThoughtIds,
        openGroupIds,
      )
    ) {
      return true;
    }
    if (
      appendTimelineDelta(
        oldTimeline,
        m,
        openToolIds,
        openThoughtIds,
        openGroupIds,
      )
    ) {
      return true;
    }
  }
  const nextTimeline = renderAssistantTimeline(
    m,
    openToolIds,
    openThoughtIds,
    openGroupIds,
  );
  if (oldTimeline) oldTimeline.replaceWith(nextTimeline);
  else wrap.appendChild(nextTimeline);
  return true;
}

function renderMessages(messages, opts) {
  const force = !!(opts && opts.force);
  const next = messages || [];
  const stick = shouldStickToBottom(
    messagesEl.scrollTop,
    messagesEl.scrollHeight,
    messagesEl.clientHeight,
    busy ? 96 : 48,
  );

  // Streaming fast path: only the last assistant bubble changed — avoid wiping
  // the whole list (main source of UI jank / flicker while tokens arrive).
  if (
    !force &&
    allMessages.length > 0 &&
    isStreamingTailUpdate(allMessages, next) &&
    allMessages.length <= VIRT_THRESHOLD
  ) {
    allMessages = next;
    emptyEl.hidden = true;
    if (patchLastAssistant(next[next.length - 1])) {
      if (stick) requestStickScroll({ force: true });
      return;
    }
  }

  const prevIds = new Set(allMessages.map((m) => m && m.id).filter(Boolean));
  allMessages = next;
  emptyEl.hidden = allMessages.length > 0;
  messagesEl.innerHTML = "";

  let start = 0;
  let end = allMessages.length;
  if (allMessages.length > VIRT_THRESHOLD) {
    const w = computeVirtualWindow({
      total: allMessages.length,
      scrollTop: messagesEl.scrollTop,
      viewportHeight: messagesEl.clientHeight || 400,
      estimatedRowHeight: EST_ROW,
      overscan: 6,
    });
    start = w.start;
    end = w.end;
    const top = document.createElement("div");
    top.className = "vspacer";
    top.style.height = start * EST_ROW + "px";
    messagesEl.appendChild(top);
  }

  for (let i = start; i < end; i++) {
    const m = allMessages[i];
    // Enter anim only for messages that just appeared (not history load / re-mount).
    const isNew = !!(m && m.id && !prevIds.has(m.id) && prevIds.size > 0);
    messagesEl.appendChild(renderOneMessage(m, isNew));
    if (m && m.id) seenMsgIds.add(m.id);
  }

  if (allMessages.length > VIRT_THRESHOLD) {
    const bottom = document.createElement("div");
    bottom.className = "vspacer";
    bottom.style.height = (allMessages.length - end) * EST_ROW + "px";
    messagesEl.appendChild(bottom);
  }

  // Prune seen ids that left the conversation
  const live = new Set(allMessages.map((m) => m && m.id).filter(Boolean));
  for (const id of seenMsgIds) {
    if (!live.has(id)) seenMsgIds.delete(id);
  }

  // Only the live tail assistant streams; strip loading UI from older bubbles.
  settleNonLiveAssistantStreams();

  if (stick || allMessages.length <= VIRT_THRESHOLD) {
    requestStickScroll({ force: true, smooth: true });
  }
}

/** Drop streaming class + skeleton shimmer from every non-live assistant. */
function settleNonLiveAssistantStreams() {
  const nodes = messagesEl.querySelectorAll(".msg.assistant");
  if (!nodes.length) return;
  const last = nodes[nodes.length - 1];
  nodes.forEach((el) => {
    const live = busy && el === last;
    el.classList.toggle("streaming", live);
    if (!live) {
      el.querySelectorAll(".stream-shimmer").forEach((s) => s.remove());
      el.querySelectorAll(".tool-latest").forEach((t) =>
        t.classList.remove("tool-latest"),
      );
    }
  });
  if (busy && last) {
    const lastMsg =
      allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;
    if (lastMsg && lastMsg.type === "assistant") {
      const tl = last.querySelector(":scope > .assistant-timeline");
      if (tl) ensureStreamShimmer(tl, lastMsg, true);
    }
  }
}

function renderSticky() {
  let html = "";
  // Always use the same chip shell for auto on/off (same icons + label + action slot)
  // so toggling does not reflow the sticky row.
  if (autoChip) {
    const on = !!autoAttachEnabled;
    const title = on
      ? "Auto-attached from focused editor — click × to disable"
      : "Auto-attach off — click to enable for focused file";
    const action = on
      ? '<button type="button" data-auto-toggle="0" title="Disable auto-attach">×</button>'
      : '<button type="button" data-auto-toggle="1" title="Enable auto-attach">' +
        icon("plus") +
        "</button>";
    html +=
      '<span class="chip chip-auto' +
      (on ? "" : " chip-auto-off") +
      '" title="' +
      esc(title) +
      '"' +
      (on ? "" : ' data-auto-toggle="1" role="button" tabindex="0"') +
      ">" +
      '<span class="chip-badge" aria-hidden="true">' +
      icon("focus-2") +
      "</span>" +
      icon(chipIcon(autoChip.label)) +
      '<span class="chip-label">' +
      esc(autoChip.label) +
      "</span>" +
      action +
      "</span>";
  }
  html += stickyChips
    .map(
      (c) =>
        '<span class="chip">' +
        icon(chipIcon(c.label)) +
        '<span class="chip-label">' +
        esc(c.label) +
        "</span>" +
        '<button type="button" data-chip-id="' +
        esc(c.id) +
        '" title="Remove">×</button></span>',
    )
    .join("");
  stickyEl.innerHTML = html;
}

function setMeta(text, spinning) {
  meta.innerHTML =
    (spinning ? icon("loader", "ti-spin") : icon("circle-dashed")) +
    "<span>" +
    esc(text) +
    "</span>";
}

// Context usage: header chip + composer (mode | circle | used / window).
function renderContextBar(c) {
  const hide = !c || !c.visible || !c.text;
  if (hide) {
    if (ctxBarEl) {
      ctxBarEl.hidden = true;
      ctxBarEl.textContent = "";
      ctxBarEl.className = "";
      ctxBarEl.removeAttribute("title");
    }
    if (ctxUsageEl) {
      ctxUsageEl.hidden = true;
      ctxUsageEl.className = "ctx-usage";
      ctxUsageEl.removeAttribute("title");
      if (ctxUsageTextEl) ctxUsageTextEl.textContent = "—";
      if (ctxRingFillEl) {
        ctxRingFillEl.style.strokeDasharray = String(CTX_RING_C);
        ctxRingFillEl.style.strokeDashoffset = String(CTX_RING_C);
      }
    }
    return;
  }

  const level = c.level || "ok";
  const title = c.title || "Context " + c.text;
  const pct = Math.max(0, Math.min(100, Number(c.pct) || 0));

  // Header top-right (text only).
  if (ctxBarEl) {
    ctxBarEl.hidden = false;
    ctxBarEl.textContent = c.text;
    ctxBarEl.className = "level-" + level;
    ctxBarEl.title = title;
  }

  // Composer: mode | circle progress | tokens / context window.
  if (ctxUsageEl) {
    ctxUsageEl.hidden = false;
    ctxUsageEl.className = "ctx-usage level-" + level;
    ctxUsageEl.title = title;
    if (ctxUsageTextEl) ctxUsageTextEl.textContent = c.text;
    if (ctxRingFillEl) {
      const offset = CTX_RING_C * (1 - pct / 100);
      ctxRingFillEl.style.strokeDasharray = String(CTX_RING_C);
      ctxRingFillEl.style.strokeDashoffset = String(offset);
    }
  }
}

function renderTurnStatus(s) {
  if (!s) return;
  if (s.context) renderContextBar(s.context);

  if (!s.visible) {
    turnStatusEl.hidden = true;
    turnStatusEl.classList.remove("busy");
    return;
  }
  turnStatusEl.hidden = false;
  turnStatusEl.classList.toggle("busy", !!s.spinning);
  tsProcess.textContent = s.process || "";
  tsTime.textContent = s.time || "";
  tsTokens.textContent = s.tokens || "";
  tsCost.textContent = s.cost || "";
  tsTime.style.display = s.time ? "" : "none";
  tsTokens.style.display = s.tokens ? "" : "none";
  tsCost.style.display = s.cost ? "" : "none";
}

function setBlockingLoad(active, message) {
  const el = document.getElementById("blocking-load");
  const label = document.getElementById("blocking-load-label");
  if (!el) return;
  if (active) {
    if (label) label.textContent = message || "Loading…";
    el.hidden = false;
    el.classList.add("active");
    el.setAttribute("aria-busy", "true");
  } else {
    el.hidden = true;
    el.classList.remove("active");
    el.setAttribute("aria-busy", "false");
  }
}

function setBusy(b) {
  const wasBusy = busy;
  busy = b;
  composer.disabled = cliMissing;
  syncComposerPlaceholder();
  if (b) setMeta("working…", true);
  else setMeta(meta.dataset.base || "idle", false);
  // Always re-scope stream UI to the live tail (or clear when idle).
  settleNonLiveAssistantStreams();
  if (!b && wasBusy) {
    // Turn ended: drop any leftover shimmer + re-render tail to full markdown.
    messagesEl.querySelectorAll(".stream-shimmer").forEach((el) => el.remove());
    const lastMsg =
      allMessages.length > 0 ? allMessages[allMessages.length - 1] : null;
    if (lastMsg && lastMsg.type === "assistant") {
      patchLastAssistant(lastMsg);
    }
  }
  updateSendStopButton();
}

/** Composer image attachments (host-authoritative list for previews). */
let imageAttachments = [];

/** UI label for an attachment — never TUI `[Image #N]` chips (preview cards are enough). */
function imageUiLabel(img) {
  if (img && img.fileName) return String(img.fileName);
  if (img && img.label && !/^\[Image #\d+\]$/.test(String(img.label))) {
    return String(img.label);
  }
  const n = img && img.displayNumber != null ? img.displayNumber : "?";
  return "Image " + n;
}

function renderMsgImages(images) {
  const row = document.createElement("div");
  row.className = "msg-images";
  for (const img of images) {
    const fig = document.createElement("figure");
    fig.className = "msg-image";
    const label = imageUiLabel(img);
    if (img.thumbUri) {
      const el = document.createElement("img");
      el.src = img.thumbUri;
      el.alt = label;
      el.loading = "lazy";
      if (img.openPath) {
        el.style.cursor = "pointer";
        el.addEventListener("click", () =>
          vscode.postMessage({ type: "openImage", path: img.openPath }),
        );
      }
      fig.appendChild(el);
    }
    const cap = document.createElement("figcaption");
    cap.textContent = label;
    cap.title = label; // full name on hover when truncated to 1 line
    fig.appendChild(cap);
    row.appendChild(fig);
  }
  return row;
}

function renderImagePreviews() {
  const el = document.getElementById("image-previews");
  if (!el) return;
  if (!imageAttachments.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  // Compact thumbs above the textarea (no caption row — label via title).
  el.innerHTML = imageAttachments
    .map((img) => {
      const label = imageUiLabel(img);
      const title = escAttr(
        [label, img.width && img.height ? img.width + "×" + img.height : ""]
          .filter(Boolean)
          .join(" · "),
      );
      const src = img.thumbUri ? ' src="' + escAttr(img.thumbUri) + '"' : "";
      return (
        '<figure class="image-card" data-image-id="' +
        escAttr(img.id) +
        '">' +
        '<button type="button" class="image-card-open" data-open-path="' +
        escAttr(img.openPath || "") +
        '" title="' +
        title +
        '">' +
        (src
          ? '<img class="image-card-img"' +
            src +
            ' alt="' +
            escAttr(label) +
            '" />'
          : '<span class="image-card-missing">' + esc(label) + "</span>") +
        "</button>" +
        '<button type="button" class="image-card-remove" data-image-id="' +
        escAttr(img.id) +
        '" title="Remove ' +
        escAttr(label) +
        '" aria-label="Remove ' +
        escAttr(label) +
        '">×</button>' +
        "</figure>"
      );
    })
    .join("");
}

function escAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

/**
 * Strip legacy TUI `[Image #N]` chips from composer text.
 * Extension has visual image cards — tokens are redundant and confusing.
 */
function stripComposerImageTokens() {
  const v = composer.value;
  if (!/\[Image #\d+\]/.test(v)) return;
  const start = composer.selectionStart;
  const end = composer.selectionEnd;
  const next = v.replace(/\s*\[Image #\d+\]/g, "").replace(/[ \t]{2,}/g, " ");
  if (next === v) return;
  composer.value = next;
  const pos = Math.min(start, next.length);
  const endPos = Math.min(end, next.length);
  composer.selectionStart = pos;
  composer.selectionEnd = endPos;
  autosizeComposer();
}

function applyImageAttachments(msg) {
  imageAttachments = msg.images || [];
  // Never insert/renumber `[Image #N]` in the composer (UI cards only).
  stripComposerImageTokens();
  renderImagePreviews();
  updateSendStopButton();
}

/**
 * Primary action button modes (no inject/send-now here — that lives on queue rows):
 * - idle + text → Send
 * - busy + empty → Stop
 * - busy + text → Queue
 * - idle + images only → Send
 */
function updateSendStopButton() {
  const empty = !composer.value.trim() && imageAttachments.length === 0;
  const asStop = busy && empty && !cliMissing && !queueEditActive && !planOpen;
  const asQueue =
    busy &&
    !empty &&
    !cliMissing &&
    !queueEditActive &&
    !pendingEdit &&
    !planOpen;
  const asPlanFeedback = planOpen && !cliMissing;
  sendBtn.classList.toggle("is-stop", asStop);
  // Allow send while busy (queues). Only block when CLI missing.
  // Plan mode: enable even when empty (no-op) so button stays usable for feedback.
  sendBtn.disabled =
    cliMissing ||
    (!planOpen && !busy && empty && !pendingEdit && !queueEditActive);
  if (cliMissing) {
    sendBtn.innerHTML = '<i class="ti ti-send" aria-hidden="true"></i>';
    sendBtn.title = "Install Grok Build CLI first";
    sendBtn.setAttribute("aria-label", "Send (disabled — CLI missing)");
  } else if (asPlanFeedback) {
    sendBtn.innerHTML = '<i class="ti ti-edit" aria-hidden="true"></i>';
    sendBtn.title = empty
      ? "Type plan feedback, then press Enter / Request changes"
      : "Request plan changes with composer text (Enter)";
    sendBtn.setAttribute("aria-label", "Request plan changes");
  } else if (asStop) {
    sendBtn.innerHTML = '<i class="ti ti-player-stop" aria-hidden="true"></i>';
    sendBtn.title = "Stop current turn (Esc)";
    sendBtn.setAttribute("aria-label", "Stop");
  } else if (queueEditActive) {
    sendBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i>';
    sendBtn.title = "Save queued prompt edit";
    sendBtn.setAttribute("aria-label", "Save queue edit");
  } else if (pendingEdit) {
    sendBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i>';
    sendBtn.title = "Resubmit edited message (choose rewind mode)";
    sendBtn.setAttribute("aria-label", "Resubmit");
  } else if (asQueue) {
    sendBtn.innerHTML = '<i class="ti ti-stack-2" aria-hidden="true"></i>';
    sendBtn.title = "Queue follow-up (runs after current turn)";
    sendBtn.setAttribute("aria-label", "Queue");
  } else {
    sendBtn.innerHTML = '<i class="ti ti-send" aria-hidden="true"></i>';
    sendBtn.title = "Send";
    sendBtn.setAttribute("aria-label", "Send");
  }
}

function defaultComposerPlaceholder() {
  if (cliMissing) return "Install Grok Build CLI to chat…";
  if (planOpen) {
    return "Plan feedback… (Enter = request changes · ⌘/Ctrl+Enter approve · Esc abandon)";
  }
  if (queueEditActive) return "Edit queued prompt… (Enter save · Esc cancel)";
  if (busy) {
    return "Queue a follow-up… (Enter queues · empty Enter stops)";
  }
  return "Message Grok… (/ commands, @ files, Enter send · Shift+Tab mode)";
}

function syncComposerPlaceholder() {
  if (!composer || pendingEdit) return;
  composer.placeholder = defaultComposerPlaceholder();
}

function renderTasks(items, runningCount) {
  taskItems = Array.isArray(items) ? items.slice() : [];
  const pane = document.getElementById("tasks-pane");
  const list = document.getElementById("tasks-list");
  const title = document.getElementById("tasks-title");
  if (!pane || !list || !title) return;
  const n = taskItems.length;
  const run =
    typeof runningCount === "number"
      ? runningCount
      : taskItems.filter(
          (t) => t.status === "running" || t.status === "stopping",
        ).length;
  if (n === 0) {
    pane.classList.remove("visible");
    list.innerHTML = "";
    title.textContent = "Background";
    return;
  }
  pane.classList.add("visible");
  if (run > 0) {
    title.textContent =
      run === 1
        ? "1 running"
        : run + " running" + (n > run ? " · " + n + " total" : "");
  } else {
    title.textContent = n === 1 ? "1 finished" : n + " finished";
  }
  list.innerHTML = "";
  taskItems.forEach((t) => {
    const row = document.createElement("div");
    const st = t.status || "running";
    row.className = "task-row " + st + " kind-" + (t.kind || "task");
    row.dataset.id = t.id;
    row.dataset.kind = t.kind || "task";
    row.setAttribute("role", "listitem");
    const detail = t.detail || t.statusLabel || "";
    const elapsed = t.elapsed || "";
    const canKill =
      t.canKill !== false && (st === "running" || st === "stopping");
    const canView = t.canView !== false;
    row.innerHTML =
      '<span class="t-status" title="' +
      esc(t.statusLabel || st) +
      '" aria-hidden="true"></span>' +
      '<span class="t-body" title="' +
      esc([t.tag, t.label, detail].filter(Boolean).join(" — ")) +
      '">' +
      '<span class="t-main">' +
      '<span class="t-tag">' +
      esc(t.tag || "Task") +
      "</span>" +
      '<span class="t-label">' +
      esc(t.label || t.id) +
      "</span>" +
      "</span>" +
      (detail ? '<span class="t-detail">' + esc(detail) + "</span>" : "") +
      "</span>" +
      '<span class="t-meta">' +
      esc(elapsed) +
      "</span>" +
      '<span class="t-actions">' +
      '<button type="button" data-t-act="view" title="View output" aria-label="View output" ' +
      (canView ? "" : "disabled") +
      '><i class="ti ti-eye" aria-hidden="true"></i></button>' +
      '<button type="button" data-t-act="kill" title="Stop" aria-label="Stop" ' +
      (canKill ? "" : "disabled") +
      '><i class="ti ti-x" aria-hidden="true"></i></button>' +
      "</span>";
    list.appendChild(row);
  });
}

function renderQueue(entries) {
  queueEntries = Array.isArray(entries) ? entries.slice() : [];
  const pane = document.getElementById("queue-pane");
  const list = document.getElementById("queue-list");
  const title = document.getElementById("queue-title");
  if (!pane || !list || !title) return;
  const n = queueEntries.length;
  if (n === 0) {
    pane.classList.remove("visible");
    list.innerHTML = "";
    title.textContent = "Queued";
    syncComposerPlaceholder();
    updateSendStopButton();
    return;
  }
  pane.classList.add("visible");
  title.textContent = n === 1 ? "1 queued" : n + " queued";
  list.innerHTML = "";
  queueEntries.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "queue-row" + (e.optimistic ? " optimistic" : "");
    row.dataset.id = e.id;
    row.setAttribute("role", "listitem");
    const kind = e.kind && e.kind !== "prompt" ? e.kind : "";
    const line = e.firstLine || e.text || "";
    row.innerHTML =
      '<span class="q-pos">#' +
      (i + 1) +
      "</span>" +
      '<span class="q-body" title="' +
      esc(e.text || "") +
      '">' +
      (kind ? '<span class="q-kind">' + esc(kind) + "</span>" : "") +
      '<span class="q-text">' +
      esc(line) +
      "</span>" +
      "</span>" +
      '<span class="q-actions">' +
      '<button type="button" data-q-act="up" title="Move up" aria-label="Move up" ' +
      (i === 0 ? "disabled" : "") +
      '><i class="ti ti-arrow-up" aria-hidden="true"></i></button>' +
      '<button type="button" data-q-act="down" title="Move down" aria-label="Move down" ' +
      (i === n - 1 ? "disabled" : "") +
      '><i class="ti ti-arrow-down" aria-hidden="true"></i></button>' +
      '<button type="button" data-q-act="now" title="Send now" aria-label="Send now">' +
      '<i class="ti ti-bolt" aria-hidden="true"></i></button>' +
      '<button type="button" data-q-act="edit" title="Edit" aria-label="Edit">' +
      '<i class="ti ti-pencil" aria-hidden="true"></i></button>' +
      '<button type="button" data-q-act="remove" title="Remove" aria-label="Remove">' +
      '<i class="ti ti-x" aria-hidden="true"></i></button>' +
      "</span>";
    list.appendChild(row);
  });
  syncComposerPlaceholder();
  updateSendStopButton();
}

function setQueueEditMode(active, text) {
  queueEditActive = !!active;
  const ban = document.getElementById("queue-edit-banner");
  if (ban) ban.classList.toggle("visible", queueEditActive);
  if (queueEditActive) {
    composer.value = text || "";
    autosizeComposer();
    composer.focus();
  }
  syncComposerPlaceholder();
  updateSendStopButton();
}

function setReview(count) {
  if (count > 0) {
    reviewBar.classList.add("visible");
    reviewLabel.textContent = "Review edits (" + count + ")";
  } else {
    reviewBar.classList.remove("visible");
  }
}

messagesEl.addEventListener("scroll", () => {
  if (allMessages.length > VIRT_THRESHOLD) {
    const stick = shouldStickToBottom(
      messagesEl.scrollTop,
      messagesEl.scrollHeight,
      messagesEl.clientHeight,
    );
    if (!stick) renderMessages(allMessages);
  }
});

messagesEl.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-path]");
  if (a) {
    e.preventDefault();
    vscode.postMessage({ type: "openFile", path: a.getAttribute("data-path") });
    return;
  }
  const d = e.target.closest("[data-diff]");
  if (d) {
    e.preventDefault();
    vscode.postMessage({ type: "openDiff", path: d.getAttribute("data-diff") });
  }
});

stickyEl.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-auto-toggle]");
  if (toggle) {
    const enabled = toggle.getAttribute("data-auto-toggle") === "1";
    vscode.postMessage({ type: "setAutoAttach", enabled });
    return;
  }
  const btn = e.target.closest("[data-chip-id]");
  if (btn) {
    vscode.postMessage({
      type: "removeChip",
      id: btn.getAttribute("data-chip-id"),
    });
  }
});

sendBtn.addEventListener("click", () => {
  if (mentionOpen) closeMention();
  if (slashOpen) closeSlash();
  if (modelOpen) closeModelPopover();
  if (effortOpen) closeEffortPopover();
  if (rewindOpen) {
    acceptRewind(rewindIndex);
    return;
  }
  // Plan approval: composer text is plan feedback (Request changes).
  if (planOpen) {
    const text = composer.value.trim();
    if (!text) {
      // Empty → nudge user to type feedback (do not Stop / Approve).
      composer.focus();
      return;
    }
    submitPlanRequestChanges();
    return;
  }
  // Busy + empty → Stop (inject/send-now is only on queue-row bolt buttons)
  if (busy && !composer.value.trim() && !queueEditActive) {
    vscode.postMessage({ type: "cancel" });
    return;
  }
  if (trySubmitPendingEdit()) return;
  const text = composer.value.trim();
  // Allow send while busy: host queues a follow-up (TUI mid-turn Enter).
  // Image-only send when attachments present.
  if (!text && imageAttachments.length === 0) return;
  vscode.postMessage({ type: "send", text });
  composer.value = "";
  // Host clears attachments via imageAttachments message after takeForSend.
  autosizeComposer();
  updateSendStopButton();
});

btnModel.addEventListener("click", () => {
  if (modelOpen) closeModelPopover();
  else openModelPopover();
});
btnEffort.addEventListener("click", () => {
  if (effortOpen) closeEffortPopover();
  else openEffortPopover();
});
document
  .getElementById("empty-start")
  .addEventListener("click", () => vscode.postMessage({ type: "startAgent" }));
document.getElementById("empty-auth").addEventListener("click", () => {
  const btn = document.getElementById("empty-auth");
  const action = (btn && btn.getAttribute("data-action")) || "login";
  vscode.postMessage({ type: action === "logout" ? "logout" : "login" });
});
const emptyCheckSubEl = document.getElementById("empty-check-sub");
if (emptyCheckSubEl) {
  emptyCheckSubEl.addEventListener("click", () =>
    vscode.postMessage({ type: "checkSubscription" }),
  );
}
document
  .getElementById("empty-copy-install")
  ?.addEventListener("click", () =>
    vscode.postMessage({ type: "copyInstallCommand" }),
  );
document
  .getElementById("empty-install-cmd")
  ?.addEventListener("click", () =>
    vscode.postMessage({ type: "copyInstallCommand" }),
  );
document
  .getElementById("empty-install-cmd")
  ?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      vscode.postMessage({ type: "copyInstallCommand" });
    }
  });
document
  .getElementById("empty-recheck")
  ?.addEventListener("click", () => vscode.postMessage({ type: "recheckCli" }));
document
  .getElementById("empty-open-docs")
  ?.addEventListener("click", () =>
    vscode.postMessage({ type: "openInstallDocs" }),
  );
document
  .getElementById("empty-set-path")
  ?.addEventListener("click", () =>
    vscode.postMessage({ type: "setBinaryPath" }),
  );
document
  .getElementById("btn-review")
  .addEventListener("click", () => vscode.postMessage({ type: "reviewEdits" }));
const btnReviewAccept = document.getElementById("btn-review-accept");
if (btnReviewAccept) {
  btnReviewAccept.addEventListener("click", () =>
    vscode.postMessage({ type: "acceptAllEdits" }),
  );
}
const btnReviewReject = document.getElementById("btn-review-reject");
if (btnReviewReject) {
  btnReviewReject.addEventListener("click", () =>
    vscode.postMessage({ type: "rejectAllEdits" }),
  );
}

mentionList.addEventListener("mousedown", (e) => {
  // Prevent composer blur before click completes.
  e.preventDefault();
});
mentionList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-idx]");
  if (!btn) return;
  acceptMention(Number(btn.getAttribute("data-idx")));
});
slashList.addEventListener("mousedown", (e) => {
  e.preventDefault();
});
slashList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-slash-idx]");
  if (!btn) return;
  acceptSlash(Number(btn.getAttribute("data-slash-idx")));
});
modelList.addEventListener("mousedown", (e) => {
  e.preventDefault();
});
modelList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-model-idx]");
  if (!btn) return;
  acceptModel(Number(btn.getAttribute("data-model-idx")));
});
effortList.addEventListener("mousedown", (e) => {
  e.preventDefault();
});
effortList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-effort-idx]");
  if (!btn) return;
  acceptEffort(Number(btn.getAttribute("data-effort-idx")));
});

/** Grow #composer with content; cap at max-height and scroll when full. */
function autosizeComposer() {
  if (!composer) return;
  const minPx = 44; // match #composer min-height
  const maxPx = 180;
  composer.style.height = "auto";
  const sh = composer.scrollHeight;
  const next = Math.min(Math.max(sh, minPx), maxPx);
  composer.style.height = next + "px";
  composer.style.overflowY = sh > maxPx ? "auto" : "hidden";
}

composer.addEventListener("input", () => {
  autosizeComposer();
  syncComposerMenus();
  updateSendStopButton();
});
composer.addEventListener("click", () => syncComposerMenus());
composer.addEventListener("keyup", (e) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    syncComposerMenus();
  }
});

btnMode.addEventListener("click", () => {
  vscode.postMessage({ type: "cycleMode" });
});

/**
 * Global key handling for ALL popovers (capture phase).
 * Model/effort open from header buttons without focusing the composer — Esc and
 * arrow keys must work even when focus is not in the input.
 */
window.addEventListener(
  "keydown",
  (e) => {
    if (permissionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        movePermission(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        movePermission(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (permissionItems.length) {
          e.preventDefault();
          acceptPermission(permissionIndex);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePermissionPopover({ outcome: "cancelled" });
        return;
      }
    }
    if (questionOpen) {
      const inNotes = document.activeElement === questionNotes;
      if (!inNotes && e.key === "ArrowDown") {
        e.preventDefault();
        moveQuestion(1);
        return;
      }
      if (!inNotes && e.key === "ArrowUp") {
        e.preventDefault();
        moveQuestion(-1);
        return;
      }
      if (!inNotes && (e.key === " " || e.key === "Spacebar")) {
        e.preventDefault();
        toggleQuestionOption(questionIndex);
        return;
      }
      if (!inNotes && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        acceptQuestion();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeQuestionPopover({ outcome: "cancelled" });
        return;
      }
    }
    if (planOpen) {
      // ⌘/Ctrl+Enter → approve; Esc → abandon.
      // Plain Enter is handled on composer → Request changes via sendBtn.
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        closePlanPanel({ outcome: "approved" });
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closePlanPanel({ outcome: "abandoned" });
        return;
      }
    }
    if (sessionRewindOpen) {
      if (sessionRewindPhase === "busy") {
        if (e.key === "Escape") {
          e.preventDefault();
          // Allow cancel even while busy (host will ignore if mid-RPC).
          vscode.postMessage({ type: "sessionRewindCancel" });
        }
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        sessionRewindMove(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        sessionRewindMove(-1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        sessionRewindAcceptActive();
        return;
      }
      if (e.key === "Backspace" && sessionRewindPhase !== "points") {
        e.preventDefault();
        vscode.postMessage({ type: "sessionRewindBack" });
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        vscode.postMessage({ type: "sessionRewindCancel" });
        return;
      }
    }
    if (subagentOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeSubagentPanel(true);
        return;
      }
    }
    if (modelOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveModel(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveModel(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (modelItems.length) {
          e.preventDefault();
          acceptModel(modelIndex);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeModelPopover();
        return;
      }
    }
    if (effortOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveEffort(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveEffort(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (effortItems.length) {
          e.preventDefault();
          acceptEffort(effortIndex);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeEffortPopover();
        return;
      }
    }
    if (rewindOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveRewind(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveRewind(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        acceptRewind(rewindIndex);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeRewindPopover();
        return;
      }
    }
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveSlash(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveSlash(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (slashItems.length) {
          e.preventDefault();
          acceptSlash(slashIndex);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlash();
        return;
      }
    }
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveMention(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        moveMention(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (mentionItems.length) {
          e.preventDefault();
          acceptMention(mentionIndex);
          return;
        }
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }
  },
  true,
);

composer.addEventListener("keydown", (e) => {
  // TUI Shift+Tab: cycle Normal → Plan → Always-Approve (even with draft text).
  if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    vscode.postMessage({ type: "cycleMode" });
    return;
  }
  // Popover nav/Esc handled on window capture above — do not also Send/Cancel.
  if (
    permissionOpen ||
    questionOpen ||
    modelOpen ||
    effortOpen ||
    rewindOpen ||
    slashOpen ||
    mentionOpen
  ) {
    return;
  }
  if (pendingEdit && e.key === "Escape") {
    e.preventDefault();
    cancelPendingEdit();
    return;
  }
  if (queueEditActive && e.key === "Escape") {
    e.preventDefault();
    vscode.postMessage({ type: "queueEditCancel" });
    setQueueEditMode(false);
    composer.value = "";
    autosizeComposer();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    // Enter with empty input while busy → send-now / stop; else send/queue
    sendBtn.click();
  }
  if (e.key === "Escape" && busy && !queueEditActive) {
    vscode.postMessage({ type: "cancel" });
  }
});

// Tasks pane actions (background work / subagents)
const tasksListEl = document.getElementById("tasks-list");
const tasksRefreshBtn = document.getElementById("tasks-refresh");
if (tasksListEl) {
  tasksListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-t-act]");
    if (!btn || btn.disabled) return;
    const row = btn.closest(".task-row");
    if (!row) return;
    const id = row.dataset.id;
    const kind = row.dataset.kind || "task";
    const act = btn.getAttribute("data-t-act");
    if (act === "kill") {
      vscode.postMessage({ type: "taskKill", id, kind });
    } else if (act === "view") {
      vscode.postMessage({ type: "taskView", id, kind });
    }
  });
}
if (tasksRefreshBtn) {
  tasksRefreshBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "tasksRefresh" });
  });
}

// Queue pane actions
const queueListEl = document.getElementById("queue-list");
const queueClearBtn = document.getElementById("queue-clear");
const queueEditCancelBtn = document.getElementById("queue-edit-cancel");
if (queueListEl) {
  queueListEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-q-act]");
    if (!btn) return;
    const row = btn.closest(".queue-row");
    if (!row) return;
    const id = row.dataset.id;
    const act = btn.getAttribute("data-q-act");
    const entry = queueEntries.find((x) => x.id === id);
    if (!entry) return;
    if (act === "remove") {
      vscode.postMessage({
        type: "queueRemove",
        id,
        expectedVersion: entry.version || 0,
      });
    } else if (act === "now") {
      vscode.postMessage({
        type: "queueInterject",
        id,
        expectedVersion: entry.version || 0,
      });
    } else if (act === "edit") {
      vscode.postMessage({ type: "queueEditStart", id });
    } else if (act === "up" || act === "down") {
      const ids = queueEntries.map((x) => x.id);
      const idx = ids.indexOf(id);
      if (idx < 0) return;
      const j = act === "up" ? idx - 1 : idx + 1;
      if (j < 0 || j >= ids.length) return;
      const tmp = ids[idx];
      ids[idx] = ids[j];
      ids[j] = tmp;
      vscode.postMessage({ type: "queueReorder", orderedIds: ids });
    }
  });
}
if (queueClearBtn) {
  queueClearBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "queueClear" });
  });
}
if (queueEditCancelBtn) {
  queueEditCancelBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "queueEditCancel" });
    setQueueEditMode(false);
    composer.value = "";
    autosizeComposer();
  });
}

// Keep Send/Stop + composer height in sync on first paint
autosizeComposer();
updateSendStopButton();

// ── Image paste + drop ──────────────────────────────────────────
// Full-view overlay pattern (Dropzone/Gmail):
//   1) document detects file drag → show a single full-screen overlay
//   2) overlay is the only hit target (no nested children → no flicker)
//   3) VS Code steals OS/explorer drops without Shift → toast hint
// Refs: SO counter/overlay patterns; VS Code #182449 / discussions #2820

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const FILE_DRAG_TYPES = [
  "Files",
  "text/uri-list",
  "application/vnd.code.uri-list",
  "ResourceURLs",
];
const DROP_SHIFT_HINT =
  "Drop was intercepted — hold Shift while dropping images into the chat";

const dropOverlay = document.getElementById("drop-overlay");
const dropToastEl = document.getElementById("drop-toast");

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function looksLikeImageFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith("image/")) return true;
  return IMAGE_EXT_RE.test(file.name || "");
}

function mimeFromFileName(name) {
  const m = String(name || "")
    .toLowerCase()
    .match(IMAGE_EXT_RE);
  if (!m) return "image/png";
  switch (m[1]) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    default:
      return "image/png";
  }
}

/** True when the drag payload may contain files / image paths. */
function isFileDrag(dt) {
  if (!dt || !dt.types) return false;
  try {
    const types = Array.from(dt.types);
    if (FILE_DRAG_TYPES.some((t) => types.includes(t))) return true;
    // Some VS Code / Electron builds only expose generic items mid-drag
    return types.some(
      (t) =>
        /^image\//i.test(t) ||
        /uri-list/i.test(t) ||
        t === "Files" ||
        t === "public.file-url",
    );
  } catch {
    return false;
  }
}

/**
 * @param {File} file
 * @param {"clipboard" | "drop"} source
 */
async function attachFileAsImage(file, source) {
  if (!looksLikeImageFile(file)) return false;
  try {
    const buf = await file.arrayBuffer();
    if (!buf || buf.byteLength === 0) return false;
    vscode.postMessage({
      type: "attachImageBytes",
      mimeType: file.type || mimeFromFileName(file.name),
      dataBase64: arrayBufferToBase64(buf),
      byteLength: buf.byteLength,
      fileName: file.name || "image.png",
      source: source === "drop" ? "drop" : "clipboard",
    });
    return true;
  } catch (err) {
    console.warn("attachFileAsImage failed", err);
    return false;
  }
}

function pathsFromUriList(raw) {
  if (!raw || !String(raw).trim()) return [];
  const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    let t = line.trim();
    if (!t || t.startsWith("#")) continue;
    try {
      if (t.startsWith("file:")) {
        let p = decodeURIComponent(t.replace(/^file:\/\/(localhost)?/i, ""));
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
        out.push(p);
      } else if (t.startsWith("vscode-file://")) {
        let p = decodeURIComponent(t.replace(/^vscode-file:\/\/[^/]*/i, ""));
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
        out.push(p);
      } else if (t.startsWith("vscode-resource:")) {
        let p = decodeURIComponent(t.replace(/^vscode-resource:/i, ""));
        if (p.startsWith("//file")) {
          p = p.replace(/^\/\/file/, "");
        }
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
        out.push(p);
      } else if (
        t.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(t) ||
        t.startsWith("\\\\")
      ) {
        out.push(t);
      }
    } catch {
      /* ignore */
    }
  }
  return out.filter((p) => IMAGE_EXT_RE.test(p));
}

function collectDropPaths(dt) {
  const keys = [
    "text/uri-list",
    "application/vnd.code.uri-list",
    "ResourceURLs",
    "text/plain",
  ];
  const paths = [];
  for (const k of keys) {
    try {
      paths.push(...pathsFromUriList(dt.getData(k)));
    } catch {
      /* ignore */
    }
  }
  return [...new Set(paths)];
}

/**
 * Snapshot transfer data synchronously, then attach async.
 * @param {DataTransfer | null} dt
 * @returns {Promise<number>} number of images / paths queued
 */
async function handleImageDrop(dt) {
  if (!dt) return 0;
  // Sync snapshot first — DataTransfer can be cleared after the event returns.
  const paths = collectDropPaths(dt);
  const files = [];
  if (dt.files && dt.files.length) {
    for (let i = 0; i < dt.files.length; i++) {
      const f = dt.files[i];
      if (f) files.push(f);
    }
  } else if (dt.items && dt.items.length) {
    for (let i = 0; i < dt.items.length; i++) {
      if (dt.items[i].kind !== "file") continue;
      const f = dt.items[i].getAsFile();
      if (f) files.push(f);
    }
  }

  if (paths.length) {
    vscode.postMessage({ type: "attachImagePaths", paths });
    return paths.length;
  }
  let n = 0;
  for (const file of files) {
    if (await attachFileAsImage(file, "drop")) n += 1;
  }
  return n;
}

// Clipboard paste
composer.addEventListener(
  "paste",
  (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    let found = false;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type && it.type.startsWith("image/")) {
        found = true;
        const file = it.getAsFile();
        if (file) void attachFileAsImage(file, "clipboard");
      }
    }
    if (found) {
      e.preventDefault();
      return;
    }
    const text = e.clipboardData.getData("text/plain") || "";
    if (text.trim() && IMAGE_EXT_RE.test(text)) {
      vscode.postMessage({ type: "attachImagePathsFromPaste", text });
    }
  },
  true,
);

// ── Full-view overlay drop (single hit target) ──────────────────
// Document only detects file drags and shows the overlay.
// Overlay (no interactive children) owns leave/drop — no nested flicker.
// VS Code steals OS/explorer drops unless Shift is held → toast on lost drop.

let fileDragActive = false;
let fileDropSucceeded = false;
/** Drop event received; ignore trailing dragleave while we process. */
let fileDropInFlight = false;
let dropToastTimer = 0;
let lastShiftToastAt = 0;

function showDropToast(message) {
  if (!dropToastEl) return;
  const now = Date.now();
  // Avoid spam if user drags in/out repeatedly.
  if (now - lastShiftToastAt < 3500) return;
  lastShiftToastAt = now;
  dropToastEl.textContent = message;
  dropToastEl.hidden = false;
  if (dropToastTimer) clearTimeout(dropToastTimer);
  dropToastTimer = window.setTimeout(() => {
    dropToastEl.hidden = true;
  }, 4500);
  // Host notification as well (visible outside webview).
  vscode.postMessage({ type: "dropShiftHint" });
}

function setDropOverlayVisible(visible) {
  if (!dropOverlay) return;
  if (visible) {
    dropOverlay.hidden = false;
    dropOverlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("is-drop-target");
  } else {
    dropOverlay.hidden = true;
    dropOverlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("is-drop-target");
  }
}

/**
 * @param {{ suggestShift?: boolean }} [opts]
 */
function endFileDrag(opts) {
  const wasActive = fileDragActive;
  const succeeded = fileDropSucceeded;
  fileDragActive = false;
  fileDropSucceeded = false;
  fileDropInFlight = false;
  setDropOverlayVisible(false);
  if (wasActive && !succeeded && opts && opts.suggestShift) {
    showDropToast(DROP_SHIFT_HINT);
  }
}

function beginFileDrag() {
  if (fileDragActive) return;
  fileDragActive = true;
  fileDropSucceeded = false;
  fileDropInFlight = false;
  setDropOverlayVisible(true);
}

async function completeDrop(transfer) {
  fileDropInFlight = true;
  try {
    const n = await handleImageDrop(transfer);
    if (n > 0) {
      fileDropSucceeded = true;
      endFileDrag();
    } else {
      // Empty payload usually means VS Code intercepted without Shift.
      endFileDrag({ suggestShift: true });
    }
  } catch (err) {
    console.warn("completeDrop failed", err);
    endFileDrag({ suggestShift: true });
  }
}

function preventAndAllowDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
}

// Document: detect external file drag and keep drop allowed.
document.addEventListener(
  "dragenter",
  (e) => {
    if (!isFileDrag(e.dataTransfer)) return;
    preventAndAllowDrop(e);
    beginFileDrag();
  },
  true,
);

document.addEventListener(
  "dragover",
  (e) => {
    if (fileDragActive) {
      // Keep drop allowed while overlay is up even if types flicker.
      preventAndAllowDrop(e);
      return;
    }
    if (!isFileDrag(e.dataTransfer)) return;
    preventAndAllowDrop(e);
    beginFileDrag();
  },
  true,
);

// Overlay owns leave/drop once visible (single full-screen hit target).
if (dropOverlay) {
  dropOverlay.addEventListener("dragenter", (e) => {
    preventAndAllowDrop(e);
  });

  dropOverlay.addEventListener("dragover", (e) => {
    preventAndAllowDrop(e);
  });

  dropOverlay.addEventListener("dragleave", (e) => {
    if (fileDropInFlight) return;
    // Ignore leave into the card label (pointer-events:none usually avoids this).
    const related = e.relatedTarget;
    if (related instanceof Node && dropOverlay.contains(related)) return;
    // Leaving the overlay = pointer left the webview (or VS Code stole the drag).
    endFileDrag({ suggestShift: true });
  });

  dropOverlay.addEventListener("drop", (e) => {
    preventAndAllowDrop(e);
    void completeDrop(e.dataTransfer);
  });
}

// Fallback document drop if overlay missed the event.
document.addEventListener(
  "drop",
  (e) => {
    if (!fileDragActive && !isFileDrag(e.dataTransfer)) return;
    // Overlay handler already ran for overlay-targeted drops.
    if (dropOverlay && e.target === dropOverlay) return;
    if (dropOverlay && dropOverlay.contains(/** @type {Node} */ (e.target)))
      return;
    preventAndAllowDrop(e);
    void completeDrop(e.dataTransfer);
  },
  true,
);

// Esc / focus loss cancels drag without a drop event.
window.addEventListener("blur", () => {
  if (fileDragActive && !fileDropInFlight) endFileDrag({ suggestShift: true });
});
window.addEventListener("dragend", () => {
  if (fileDragActive && !fileDropInFlight) endFileDrag({ suggestShift: true });
});

const imagePreviewsEl = document.getElementById("image-previews");
if (imagePreviewsEl) {
  imagePreviewsEl.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const rem = t.closest(".image-card-remove");
    if (rem) {
      const id = rem.getAttribute("data-image-id");
      if (id) vscode.postMessage({ type: "removeImage", id });
      return;
    }
    const open = t.closest(".image-card-open");
    if (open) {
      const p = open.getAttribute("data-open-path");
      if (p) vscode.postMessage({ type: "openImage", path: p });
    }
  });
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || !msg.type) return;
  if (msg.type === "init") {
    renderMessages(msg.messages || []);
    stickyChips = msg.stickyChips || [];
    autoAttachEnabled = msg.autoAttachEnabled !== false;
    autoChip = msg.autoChip || null;
    renderSticky();
    setReview(msg.reviewCount || 0);
    applyModelsState(msg);
    applyModeState(msg);
    const base = !msg.cliFound
      ? "cli missing"
      : (msg.agentState || "idle") +
        (msg.agentDetail ? " · " + String(msg.agentDetail).slice(0, 12) : "");
    meta.dataset.base = base;
    setBusy(!!msg.busy);
    if (msg.turnStatus) renderTurnStatus(msg.turnStatus);
    if (msg.context) renderContextBar(msg.context);
    if (msg.queue) renderQueue(msg.queue.entries || []);
    if (msg.tasks) {
      renderTasks(msg.tasks.items || [], msg.tasks.runningCount);
    }
    updateEmptyAuthUi(
      !!msg.hasAuth,
      msg.authSummary || "",
      !!msg.accessGated,
      msg.gateMessage || "",
    );
    updateEmptyCliUi(
      msg.cliFound !== false,
      msg.installCommand || "",
      msg.installTypicalPath || "",
    );
    // Always show empty install panel when CLI missing (even with leftover messages).
    emptyEl.hidden = msg.cliFound !== false && (msg.messages || []).length > 0;
    if (msg.imageAttachments) {
      applyImageAttachments({ images: msg.imageAttachments });
    }
  } else if (msg.type === "imageAttachments") {
    applyImageAttachments(msg);
  } else if (msg.type === "messages") {
    renderMessages(msg.messages || []);
  } else if (msg.type === "queue") {
    renderQueue(msg.entries || []);
  } else if (msg.type === "tasks") {
    renderTasks(msg.items || [], msg.runningCount);
  } else if (msg.type === "streamTail") {
    // New turn injected — keep shimmer only on the live assistant tail.
    settleNonLiveAssistantStreams();
  } else if (msg.type === "queueEditMode") {
    setQueueEditMode(!!msg.active, msg.text || "");
  } else if (msg.type === "restoreEditComposer") {
    restoreEditComposer(msg.id, msg.text);
  } else if (msg.type === "setComposer") {
    const draft = msg.text != null ? String(msg.text) : "";
    composer.value = draft;
    if (typeof autosizeComposer === "function") autosizeComposer();
    // Programmatic value changes do not fire "input" — refresh Send enablement.
    updateSendStopButton();
    composer.focus();
    const len = composer.value.length;
    try {
      composer.setSelectionRange(len, len);
    } catch {
      /* ignore */
    }
    if (typeof syncComposerMenus === "function") syncComposerMenus();
  } else if (msg.type === "busy") {
    setBusy(!!msg.busy);
  } else if (msg.type === "blockingLoad") {
    setBlockingLoad(!!msg.active, msg.message || "");
  } else if (msg.type === "turnStatus") {
    renderTurnStatus(msg);
  } else if (msg.type === "contextBar") {
    renderContextBar(msg);
  } else if (msg.type === "models") {
    applyModelsState(msg);
  } else if (msg.type === "mode") {
    applyModeState(msg);
  } else if (msg.type === "agentState") {
    const base =
      (msg.state || "idle") +
      (msg.detail ? " · " + String(msg.detail).slice(0, 12) : "");
    meta.dataset.base = base;
    if (!busy) setMeta(base, false);
  } else if (msg.type === "stickyChips") {
    stickyChips = msg.chips || [];
    renderSticky();
  } else if (msg.type === "autoContext") {
    autoAttachEnabled = !!msg.enabled;
    autoChip = msg.chip || null;
    renderSticky();
  } else if (msg.type === "review") {
    setReview(msg.count || 0);
  } else if (msg.type === "openMention") {
    composer.focus();
    const pos = composer.selectionStart || 0;
    const v = composer.value;
    if (!detectAtContext(v, pos)) {
      const insert = pos === 0 || /\s/.test(v[pos - 1] || "") ? "@" : " @";
      composer.value = v.slice(0, pos) + insert + v.slice(pos);
      const next = pos + insert.length;
      composer.setSelectionRange(next, next);
      autosizeComposer();
    }
    syncMentionFromComposer();
  } else if (msg.type === "openModel") {
    openModelPopover();
  } else if (msg.type === "mentionResults") {
    if (msg.requestId !== mentionRequestId) return;
    mentionItems = msg.items || [];
    mentionIndex = 0;
    if (!mentionOpen) {
      mentionOpen = true;
    }
    renderMentionList();
  } else if (msg.type === "slashResults") {
    if (msg.requestId !== slashRequestId) return;
    slashItems = msg.items || [];
    slashIndex = 0;
    if (!slashOpen) {
      slashOpen = true;
    }
    renderSlashList();
  } else if (msg.type === "permissionPrompt") {
    openPermissionPrompt(msg);
  } else if (msg.type === "closePermissionPrompt") {
    closePermissionPopover(null);
  } else if (msg.type === "questionPrompt") {
    openQuestionPrompt(msg);
  } else if (msg.type === "closeQuestionPrompt") {
    closeQuestionPopover(null);
  } else if (msg.type === "planApproval") {
    openPlanPanel(msg);
  } else if (msg.type === "closePlanApproval") {
    closePlanPanel(null);
  } else if (msg.type === "sessionRewind") {
    handleSessionRewindMessage(msg);
  } else if (msg.type === "subagentPanel") {
    openSubagentPanel(msg);
  } else if (msg.type === "subagentPanelUpdate") {
    updateSubagentPanel(msg);
  } else if (msg.type === "closeSubagentPanel") {
    closeSubagentPanel(false);
  }
});

vscode.postMessage({ type: "ready" });
