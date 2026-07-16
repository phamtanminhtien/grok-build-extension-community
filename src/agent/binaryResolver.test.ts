import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BinaryNotFoundError,
  getCliInstallInfo,
  installHint,
  isBinaryMissingError,
} from "./cliInstallInfo.ts";

describe("getCliInstallInfo", () => {
  it("returns curl installer for darwin/linux", () => {
    const mac = getCliInstallInfo("darwin", "/Users/me");
    assert.match(mac.command, /curl.*x\.ai\/cli\/install\.sh/);
    assert.equal(mac.docsUrl, "https://x.ai/cli");
    assert.ok(mac.typicalPath.includes(".grok"));
    assert.equal(mac.typicalPath, "/Users/me/.grok/bin/grok");

    const linux = getCliInstallInfo("linux", "/home/me");
    assert.match(linux.command, /curl.*install\.sh/);
  });

  it("returns PowerShell installer for win32", () => {
    const win = getCliInstallInfo("win32", "C:\\Users\\me");
    assert.match(win.command, /irm.*install\.ps1/);
    assert.match(win.typicalPath, /grok\.exe$/);
  });
});

describe("installHint", () => {
  it("includes install command and docs", () => {
    const hint = installHint("darwin", "/Users/me");
    assert.match(hint, /curl -fsSL/);
    assert.match(hint, /x\.ai\/cli/);
    assert.match(hint, /Binary Path/);
  });
});

describe("isBinaryMissingError", () => {
  it("detects BinaryNotFoundError", () => {
    assert.equal(
      isBinaryMissingError(new BinaryNotFoundError("missing")),
      true,
    );
  });

  it("detects ENOENT / not find messages", () => {
    assert.equal(
      isBinaryMissingError(new Error("Could not find the `grok` binary.")),
      true,
    );
    assert.equal(isBinaryMissingError(new Error("spawn ENOENT")), true);
  });

  it("rejects unrelated errors", () => {
    assert.equal(isBinaryMissingError(new Error("auth failed")), false);
  });
});
