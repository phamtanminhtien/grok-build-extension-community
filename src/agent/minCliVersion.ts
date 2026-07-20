/**
 * Minimum Grok CLI version gate for the extension host.
 *
 * Parses the first semver-like triple from `grok --version` output and
 * compares to a floor (settings `grok.minCliVersion`, default below).
 * Empty / "off" / "0" disables the gate.
 */

/** Default floor — raise as extension depends on newer agent surfaces. */
export const DEFAULT_MIN_GROK_CLI_VERSION = "0.1.0";

export interface SemverTriple {
  major: number;
  minor: number;
  patch: number;
}

export type MinCliCheck =
  | { ok: true; installed?: SemverTriple; min?: SemverTriple; raw: string }
  | {
      ok: false;
      reason: "below_min" | "unparseable";
      installed?: SemverTriple;
      min: SemverTriple;
      raw: string;
      message: string;
    };

/**
 * Extract the first `MAJOR.MINOR.PATCH` from a version string.
 * Accepts prefixes like `grok 0.2.5 (abc1234) [stable]`.
 */
export function parseSemverPrefix(text: string): SemverTriple | null {
  if (!text || typeof text !== "string") {
    return null;
  }
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) {
    return null;
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** Compare two triples: -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: SemverTriple, b: SemverTriple): number {
  if (a.major !== b.major) {
    return a.major < b.major ? -1 : 1;
  }
  if (a.minor !== b.minor) {
    return a.minor < b.minor ? -1 : 1;
  }
  if (a.patch !== b.patch) {
    return a.patch < b.patch ? -1 : 1;
  }
  return 0;
}

export function formatSemver(v: SemverTriple): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Whether the configured min version disables the gate.
 * Empty, "off", "none", "0", "disable", "disabled" → off.
 */
export function isMinVersionGateDisabled(minSetting: string): boolean {
  const s = minSetting.trim().toLowerCase();
  return (
    s === "" ||
    s === "off" ||
    s === "none" ||
    s === "0" ||
    s === "disable" ||
    s === "disabled"
  );
}

/**
 * Check installed CLI version against the floor.
 *
 * - Gate disabled → always ok
 * - Unparseable version → ok with warn path left to caller (do not brick)
 * - Parseable and below min → not ok
 */
export function checkMinCliVersion(
  versionOutput: string,
  minSetting: string = DEFAULT_MIN_GROK_CLI_VERSION,
): MinCliCheck {
  const raw = (versionOutput || "").trim();
  if (isMinVersionGateDisabled(minSetting)) {
    return { ok: true, raw };
  }
  const min = parseSemverPrefix(minSetting);
  if (!min) {
    // Misconfigured setting — do not block.
    return { ok: true, raw };
  }
  const installed = parseSemverPrefix(raw);
  if (!installed) {
    // unknown / hang-fallback "unknown" — allow start; caller may log.
    return { ok: true, raw, min };
  }
  if (compareSemver(installed, min) < 0) {
    const message = [
      `Grok CLI ${formatSemver(installed)} is below the minimum required ${formatSemver(min)}.`,
      "",
      "Upgrade the Grok Build CLI, then retry:",
      "  curl -fsSL https://x.ai/cli/install.sh | bash",
      "",
      "Or set Settings → Grok Build: Min CLI Version to empty to bypass (not recommended).",
      `Raw version: ${raw}`,
    ].join("\n");
    return {
      ok: false,
      reason: "below_min",
      installed,
      min,
      raw,
      message,
    };
  }
  return { ok: true, installed, min, raw };
}

export class CliVersionTooOldError extends Error {
  readonly installed?: SemverTriple;
  readonly min: SemverTriple;
  readonly raw: string;

  constructor(check: Extract<MinCliCheck, { ok: false }>) {
    super(check.message);
    this.name = "CliVersionTooOldError";
    this.installed = check.installed;
    this.min = check.min;
    this.raw = check.raw;
  }
}

export function isCliVersionTooOldError(err: unknown): boolean {
  return err instanceof CliVersionTooOldError;
}
