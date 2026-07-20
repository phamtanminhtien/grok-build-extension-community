import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkMinCliVersion,
  compareSemver,
  formatSemver,
  isMinVersionGateDisabled,
  parseSemverPrefix,
} from "./minCliVersion.ts";

describe("parseSemverPrefix", () => {
  it("parses plain and decorated versions", () => {
    assert.deepEqual(parseSemverPrefix("0.2.5"), {
      major: 0,
      minor: 2,
      patch: 5,
    });
    assert.deepEqual(parseSemverPrefix("grok 0.2.5 (abc1234) [stable]"), {
      major: 0,
      minor: 2,
      patch: 5,
    });
    assert.equal(parseSemverPrefix("unknown"), null);
    assert.equal(parseSemverPrefix(""), null);
  });
});

describe("compareSemver", () => {
  it("orders correctly", () => {
    assert.equal(
      compareSemver(
        { major: 0, minor: 1, patch: 0 },
        { major: 0, minor: 2, patch: 0 },
      ),
      -1,
    );
    assert.equal(
      compareSemver(
        { major: 1, minor: 0, patch: 0 },
        { major: 0, minor: 9, patch: 9 },
      ),
      1,
    );
    assert.equal(
      compareSemver(
        { major: 1, minor: 2, patch: 3 },
        { major: 1, minor: 2, patch: 3 },
      ),
      0,
    );
  });
});

describe("checkMinCliVersion", () => {
  it("passes when installed >= min", () => {
    const r = checkMinCliVersion("0.2.5", "0.1.0");
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(formatSemver(r.installed!), "0.2.5");
    }
  });

  it("fails when installed < min", () => {
    const r = checkMinCliVersion("0.0.9", "0.1.0");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "below_min");
      assert.match(r.message, /below the minimum/);
    }
  });

  it("allows unparseable version (do not brick)", () => {
    const r = checkMinCliVersion("unknown", "0.1.0");
    assert.equal(r.ok, true);
  });

  it("disables via empty/off", () => {
    assert.equal(isMinVersionGateDisabled(""), true);
    assert.equal(isMinVersionGateDisabled("off"), true);
    assert.equal(checkMinCliVersion("0.0.1", "").ok, true);
    assert.equal(checkMinCliVersion("0.0.1", "off").ok, true);
  });
});
