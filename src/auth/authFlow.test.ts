import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeAuthPresence,
  extractUserCode,
  formatAuthInfoSummary,
  formatGateBanner,
  formatLogoutMessage,
  isAccessGated,
  isSafeAuthUrl,
  needsManualAuthCodePaste,
  parseAuthInfoResponse,
  parseAuthUrlResponse,
  parseCheckSubscriptionResponse,
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

describe("needsManualAuthCodePaste", () => {
  it("requires paste for loopback and unknown modes", () => {
    assert.equal(needsManualAuthCodePaste("loopback", false), true);
    assert.equal(needsManualAuthCodePaste(undefined, false), true);
  });

  it("skips paste for device, command, and external provider", () => {
    assert.equal(needsManualAuthCodePaste("device", false), false);
    assert.equal(needsManualAuthCodePaste("command", false), false);
    assert.equal(needsManualAuthCodePaste("loopback", true), false);
  });
});

describe("parseAuthInfoResponse", () => {
  it("parses camelCase profile", () => {
    const info = parseAuthInfoResponse({
      methodId: "grok.com",
      email: "a@x.ai",
      firstName: "Ada",
      lastName: "Lovelace",
      teamName: "xAI",
      teamRole: "member",
      teamBlockedReasons: [],
      codingDataRetentionOptOut: false,
    });
    assert.equal(info.email, "a@x.ai");
    assert.equal(info.methodId, "grok.com");
    assert.equal(info.teamName, "xAI");
    assert.equal(info.firstName, "Ada");
  });

  it("accepts snake_case and result envelope", () => {
    const info = parseAuthInfoResponse({
      result: {
        method_id: "oidc",
        email: "b@x.ai",
        user_blocked_reason: "suspended",
        team_blocked_reasons: ["billing"],
        coding_data_retention_opt_out: true,
      },
    });
    assert.equal(info.methodId, "oidc");
    assert.equal(info.userBlockedReason, "suspended");
    assert.deepEqual(info.teamBlockedReasons, ["billing"]);
    assert.equal(info.codingDataRetentionOptOut, true);
  });
});

describe("parseCheckSubscriptionResponse / gate helpers", () => {
  it("parses gated meta", () => {
    const r = parseCheckSubscriptionResponse({
      authenticated: true,
      meta: {
        email: "a@x.ai",
        subscription_tier: "Free",
        gate: {
          message: "Upgrade required",
          url: "https://x.ai/pricing",
          label: "Upgrade",
        },
      },
    });
    assert.equal(r.authenticated, true);
    assert.equal(r.meta?.subscriptionTier, "Free");
    assert.equal(isAccessGated(r.meta), true);
    assert.match(formatGateBanner(r.meta?.gate) ?? "", /Upgrade required/);
  });

  it("ungated when no gate message", () => {
    const r = parseCheckSubscriptionResponse({
      authenticated: true,
      meta: { email: "a@x.ai", subscription_tier: "Pro" },
    });
    assert.equal(isAccessGated(r.meta), false);
    assert.equal(formatGateBanner(r.meta?.gate), undefined);
  });
});

describe("formatAuthInfoSummary", () => {
  it("builds profile line with team and gate", () => {
    const s = formatAuthInfoSummary(
      {
        email: "a@x.ai",
        firstName: "Ada",
        lastName: "L",
        teamName: "xAI",
        teamRole: "admin",
        methodId: "grok.com",
        teamBlockedReasons: [],
        codingDataRetentionOptOut: false,
      },
      {
        subscriptionTier: "Pro",
        gate: { message: "Paywall" },
      },
    );
    assert.match(s ?? "", /Ada L <a@x\.ai>/);
    assert.match(s ?? "", /team xAI \(admin\)/);
    assert.match(s ?? "", /Pro/);
    assert.match(s ?? "", /gate: Paywall/);
  });
});
