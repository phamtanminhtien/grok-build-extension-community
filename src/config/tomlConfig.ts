/**
 * Minimal helpers for reading/writing keys in `~/.grok/config.toml`.
 * Shared by permission mode, models, etc. — keeps extension aligned with CLI.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function grokConfigPath(home: string = os.homedir()): string {
  return path.join(home, ".grok", "config.toml");
}

export function readGrokConfigText(
  configPath: string = grokConfigPath(),
): string {
  try {
    return fs.readFileSync(configPath, "utf8");
  } catch {
    return "";
  }
}

export function writeGrokConfigText(
  text: string,
  configPath: string = grokConfigPath(),
): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, text, "utf8");
}

/**
 * Extract a TOML table body for `[name]` (until the next top-level `[section]`).
 */
export function extractTomlSection(
  text: string,
  name: string,
): string | undefined {
  const header = `[${name}]`;
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === header) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    return undefined;
  }
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (
      /^\[[^.\]]+\]\s*$/.test(lines[i]!) ||
      /^\[[^\]]+\.[^\]]+\]\s*$/.test(lines[i]!)
    ) {
      break;
    }
    body.push(lines[i]!);
  }
  return body.join("\n") + (body.length ? "\n" : "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read a string key from a TOML section body. */
export function matchStringKey(
  section: string,
  key: string,
): string | undefined {
  const re = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "m",
  );
  const m = section.match(re);
  return m?.[1] ?? m?.[2];
}

export function matchBoolKey(
  section: string,
  key: string,
): boolean | undefined {
  const re = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\b`,
    "im",
  );
  const m = section.match(re);
  if (!m?.[1]) {
    return undefined;
  }
  return m[1].toLowerCase() === "true";
}

/**
 * Upsert `key = "value"` under `[section]`. Creates the section if missing.
 * When `value` is empty string, removes the key line.
 */
export function upsertTomlSectionString(
  text: string,
  section: string,
  key: string,
  value: string,
): string {
  const keyRe = new RegExp(
    `^\\s*${escapeRegExp(key)}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s#\\r\\n]+)\\s*(?:#.*)?\\r?\\n?`,
    "m",
  );
  const line = value === "" ? "" : `${key} = "${value}"`;

  // If key already exists anywhere, replace or delete first match.
  if (keyRe.test(text)) {
    if (value === "") {
      return text.replace(keyRe, "");
    }
    return text.replace(keyRe, `${line}\n`);
  }

  if (value === "") {
    return text;
  }

  const headerRe = new RegExp(`^\\[${escapeRegExp(section)}\\]\\s*$`, "m");
  if (headerRe.test(text)) {
    return text.replace(headerRe, `[${section}]\n${line}`);
  }
  if (new RegExp(`^\\[${escapeRegExp(section)}\\]`, "m").test(text)) {
    return text.replace(
      new RegExp(`^(\\[${escapeRegExp(section)}\\][^\\n]*\\n)`, "m"),
      `$1${line}\n`,
    );
  }

  const base = text.endsWith("\n") || text.length === 0 ? text : `${text}\n`;
  return `${base}\n[${section}]\n${line}\n`;
}
