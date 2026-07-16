import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeAuthPresence,
  extractUserCode,
  formatLogoutMessage,
  isSafeAuthUrl,
  parseAuthUrlResponse,
  parseLogoutResponse,
  pickInteractiveAuthMethodId,
} from "./authFlow.ts";

describe("pickInteractiveAuthMethodId", () => {
  it("prefers grok.com over cached_token and api key", () => {
    const id = pickInteractiveAuthMethodId([
      { id: "cached_token", name: "cached" },
      { id: "xai.api_key", name: "api" },
      { id: "grok.com", name: "Grok" },
    ]);
    assert.equal(id, "grok.com");
  });

  it("prefers oidc when grok.com missing", () => {
    const id = pickInteractiveAuthMethodId([
      { id: "xai.api_key", name: "api" },
      { id: "oidc", name: "SSO" },
    ]);
    assert.equal(id, "oidc");
  });

  it("returns undefined when only non-interactive methods", () => {
    assert.equal(
      pickInteractiveAuthMethodId([
        { id: "cached_token" },
        { id: "xai.api_key" },
      ]),
      undefined,
    );
  });

  it("handles empty list", () => {
    assert.equal(pickInteractiveAuthMethodId([]), undefined);
    assert.equal(pickInteractiveAuthMethodId(undefined), undefined);
  });
});

describe("isSafeAuthUrl", () => {
  it("allows https", () => {
    assert.equal(isSafeAuthUrl("https://auth.x.ai/device"), true);
  });

  it("rejects http and non-http schemes", () => {
    assert.equal(isSafeAuthUrl("http://auth.x.ai/device"), false);
    assert.equal(isSafeAuthUrl("file:///etc/passwd"), false);
    assert.equal(isSafeAuthUrl("javascript:alert(1)"), false);
    assert.equal(isSafeAuthUrl("not a url"), false);
  });
});

describe("extractUserCode", () => {
  it("reads user_code query param", () => {
    assert.equal(
      extractUserCode("https://auth.x.ai/device?user_code=ABCD-1234"),
      "ABCD-1234",
    );
  });

  it("returns undefined when missing", () => {
    assert.equal(extractUserCode("https://auth.x.ai/device"), undefined);
  });
});

describe("parseAuthUrlResponse", () => {
  it("parses raw shape", () => {
    const info = parseAuthUrlResponse({
      auth_url: "https://auth.x.ai/x",
      mode: "loopback",
      external_provider: false,
    });
    assert.equal(info.authUrl, "https://auth.x.ai/x");
    assert.equal(info.mode, "loopback");
    assert.equal(info.externalProvider, false);
  });

  it("unwraps result envelope", () => {
    const info = parseAuthUrlResponse({
      result: {
        auth_url: "https://auth.x.ai/y",
        mode: "device",
        external_provider: true,
      },
    });
    assert.equal(info.authUrl, "https://auth.x.ai/y");
    assert.equal(info.externalProvider, true);
  });
});

describe("parseLogoutResponse / formatLogoutMessage", () => {
  it("parses logout result", () => {
    const r = parseLogoutResponse({
      ok: true,
      was_logged_in: true,
      email: "a@b.co",
      api_key_still_set: true,
    });
    assert.equal(r.wasLoggedIn, true);
    assert.equal(r.email, "a@b.co");
    assert.equal(r.apiKeyStillSet, true);
  });

  it("formats user-facing logout message", () => {
    const msg = formatLogoutMessage(
      {
        ok: true,
        wasLoggedIn: true,
        email: "a@b.co",
        apiKeyStillSet: false,
      },
      true,
    );
    assert.match(msg, /a@b\.co/);
    assert.match(msg, /SecretStorage/);
  });
});

describe("describeAuthPresence", () => {
  it("lists sources", () => {
    assert.equal(
      describeAuthPresence({
        hasSecretKey: true,
        hasEnvKey: false,
        hasCliAuth: true,
        cliEmail: "u@x.ai",
      }),
      "Signed in via SecretStorage API key · CLI session (u@x.ai)",
    );
  });

  it("not signed in when empty", () => {
    assert.equal(
      describeAuthPresence({
        hasSecretKey: false,
        hasEnvKey: false,
        hasCliAuth: false,
      }),
      "Not signed in",
    );
  });
});
