/**
 * Pure model-catalog helpers shared with the Grok TUI list source.
 * No vscode imports — safe for unit tests.
 */

/** One selectable model — same shape as TUI / agent catalog. */
export interface GrokModelOption {
  id: string;
  label: string;
  description?: string;
  selected?: boolean;
  /** Model supports reasoning effort selector. */
  supportsReasoningEffort?: boolean;
  /** Effort menu for this model (from meta.reasoningEfforts). */
  reasoningEfforts?: GrokEffortOption[];
  /** Catalog-default / current effort id for this model (meta.reasoningEffort). */
  reasoningEffort?: string;
}

/** Reasoning effort row — same as TUI sessionConfig category "mode". */
export interface GrokEffortOption {
  id: string;
  label: string;
  description?: string;
  selected?: boolean;
}

/**
 * Bundled fallback only when the agent catalog is empty (not started / still
 * fetching). Prefer the live list from `AgentService.getModels()`.
 */
const FALLBACK_MODELS: GrokModelOption[] = [
  { id: "grok-build", label: "Grok Build" },
];

/** TUI legacy effort menu when server sends supportsReasoningEffort but empty list. */
export const LEGACY_EFFORT_OPTIONS: GrokEffortOption[] = [
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "X-High" },
];

export function fallbackModels(): GrokModelOption[] {
  return FALLBACK_MODELS.map((m) => ({ ...m }));
}

export interface ModelCatalogSnapshot {
  models: GrokModelOption[];
  currentModelId: string;
  /** Effort menu for the *current* model (empty if unsupported). */
  efforts: GrokEffortOption[];
  currentEffortId: string;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function parseEffortOptions(
  meta: Record<string, unknown> | undefined,
  selectedId?: string,
): GrokEffortOption[] {
  if (!meta) {
    return [];
  }
  const supports = meta.supportsReasoningEffort === true;
  const raw = meta.reasoningEfforts;
  const out: GrokEffortOption[] = [];
  if (Array.isArray(raw) && raw.length > 0) {
    for (const item of raw) {
      const r = asRecord(item);
      if (!r) {
        continue;
      }
      const id = String(r.id ?? r.value ?? "").trim();
      if (!id) {
        continue;
      }
      const label = String(r.label ?? id).trim() || id;
      out.push({
        id,
        label,
        description:
          typeof r.description === "string" ? r.description : undefined,
        selected: id === selectedId,
      });
    }
  } else if (supports) {
    for (const e of LEGACY_EFFORT_OPTIONS) {
      out.push({ ...e, selected: e.id === selectedId });
    }
  }
  if (selectedId) {
    for (const e of out) {
      e.selected = e.id === selectedId;
    }
  }
  return out;
}

function parseModelInfo(raw: unknown): GrokModelOption | undefined {
  const m = asRecord(raw);
  if (!m) {
    return undefined;
  }
  const id = String(m.modelId ?? m.model_id ?? m.id ?? "").trim();
  if (!id) {
    return undefined;
  }
  const meta = asRecord(m.meta) ?? asRecord(m._meta);
  const effortId =
    typeof meta?.reasoningEffort === "string"
      ? meta.reasoningEffort
      : typeof meta?.reasoning_effort === "string"
        ? meta.reasoning_effort
        : undefined;
  const supports =
    meta?.supportsReasoningEffort === true ||
    meta?.supports_reasoning_effort === true;
  return {
    id,
    label: (typeof m.name === "string" && m.name.trim()) || id,
    description:
      typeof m.description === "string" ? m.description : undefined,
    supportsReasoningEffort: supports,
    reasoningEffort: effortId,
    reasoningEfforts: parseEffortOptions(meta, effortId),
  };
}

/**
 * Parse ACP `SessionModelState` (wire of `x.ai/models/update` and
 * `session/new` `.models`).
 */
export function parseSessionModelState(
  state: unknown,
): ModelCatalogSnapshot {
  const empty: ModelCatalogSnapshot = {
    models: [],
    currentModelId: "",
    efforts: [],
    currentEffortId: "",
  };
  const s = asRecord(state);
  if (!s) {
    return empty;
  }
  const currentModelId = String(
    s.currentModelId ?? s.current_model_id ?? "",
  ).trim();
  const avail = (s.availableModels ?? s.available_models ?? []) as unknown[];
  const models: GrokModelOption[] = [];
  const seen = new Set<string>();
  for (const item of avail) {
    const m = parseModelInfo(item);
    if (!m || seen.has(m.id)) {
      continue;
    }
    seen.add(m.id);
    m.selected = m.id === currentModelId;
    models.push(m);
  }
  const current = models.find((m) => m.id === currentModelId);
  const currentEffortId = (current?.reasoningEffort ?? "").trim();
  const efforts = current
    ? parseEffortOptions(
        current.supportsReasoningEffort || current.reasoningEfforts?.length
          ? {
              supportsReasoningEffort: !!current.supportsReasoningEffort,
              reasoningEfforts: current.reasoningEfforts,
              reasoningEffort: currentEffortId,
            }
          : undefined,
        currentEffortId,
      )
    : [];
  // Prefer the model's own effort menu when present.
  const effortsFinal =
    current?.reasoningEfforts && current.reasoningEfforts.length > 0
      ? current.reasoningEfforts.map((e) => ({
          ...e,
          selected: e.id === currentEffortId,
        }))
      : efforts;

  return {
    models,
    currentModelId,
    efforts: effortsFinal,
    currentEffortId,
  };
}

/**
 * Parse Grok session `_meta` for the model catalog + effort options.
 *
 * Sources (same as TUI):
 * - `_meta["x.ai/sessionConfig"].options[]` (category model | mode)
 * - `_meta["x.ai/sessionDetail"].currentModelId`
 * - legacy ACP `SessionModelState` on session response
 */
export function parseModelsFromSessionMeta(
  meta: Record<string, unknown> | null | undefined,
  legacyModels?: unknown,
): ModelCatalogSnapshot {
  const models: GrokModelOption[] = [];
  const efforts: GrokEffortOption[] = [];
  const seen = new Set<string>();
  const seenEffort = new Set<string>();

  const config = asRecord(meta?.["x.ai/sessionConfig"]);
  const options = (config?.options as unknown[]) ?? [];

  for (const raw of options) {
    const o = asRecord(raw);
    if (!o?.id) {
      continue;
    }
    const id = String(o.id).trim();
    const category = String(o.category ?? "");
    if (category === "model") {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      models.push({
        id,
        label: (typeof o.label === "string" && o.label.trim()) || id,
        description:
          typeof o.description === "string" ? o.description : undefined,
        selected: !!o.selected,
      });
    } else if (category === "mode") {
      // Grok maps effort levels to category "mode" in sessionConfig.
      if (seenEffort.has(id)) {
        continue;
      }
      seenEffort.add(id);
      efforts.push({
        id,
        label: (typeof o.label === "string" && o.label.trim()) || id,
        description:
          typeof o.description === "string" ? o.description : undefined,
        selected: !!o.selected,
      });
    }
  }

  const detail = asRecord(meta?.["x.ai/sessionDetail"]);
  let currentModelId = String(detail?.currentModelId ?? "").trim();
  let currentEffortId = efforts.find((e) => e.selected)?.id ?? "";

  // Merge legacy SessionModelState if richer
  if (legacyModels) {
    const legacy = parseSessionModelState(legacyModels);
    for (const m of legacy.models) {
      if (seen.has(m.id)) {
        // Enrich supports/effort from legacy if missing
        const existing = models.find((x) => x.id === m.id);
        if (existing) {
          existing.supportsReasoningEffort =
            existing.supportsReasoningEffort ?? m.supportsReasoningEffort;
          existing.reasoningEfforts =
            existing.reasoningEfforts ?? m.reasoningEfforts;
          existing.reasoningEffort =
            existing.reasoningEffort ?? m.reasoningEffort;
          if (!existing.label || existing.label === existing.id) {
            existing.label = m.label;
          }
        }
        continue;
      }
      seen.add(m.id);
      models.push(m);
    }
    if (!currentModelId && legacy.currentModelId) {
      currentModelId = legacy.currentModelId;
    }
    if (efforts.length === 0 && legacy.efforts.length > 0) {
      efforts.push(...legacy.efforts);
      currentEffortId = legacy.currentEffortId;
    }
  }

  if (!currentModelId) {
    currentModelId = models.find((m) => m.selected)?.id ?? "";
  }
  for (const m of models) {
    m.selected = m.id === currentModelId;
  }
  if (!currentEffortId) {
    currentEffortId = efforts.find((e) => e.selected)?.id ?? "";
  }
  for (const e of efforts) {
    e.selected = e.id === currentEffortId;
  }

  return { models, currentModelId, efforts, currentEffortId };
}

/** Display label for a model id from the catalog (TUI `display_name_for`). */
export function modelDisplayLabel(
  models: readonly GrokModelOption[],
  modelId: string,
): string {
  const id = modelId.trim();
  if (!id) {
    return "model";
  }
  const hit = models.find((m) => m.id === id);
  return hit?.label || id;
}

export function effortDisplayLabel(
  efforts: readonly GrokEffortOption[],
  effortId: string,
): string {
  const id = effortId.trim();
  if (!id) {
    return "";
  }
  const hit = efforts.find((e) => e.id === id);
  return hit?.label || id;
}
