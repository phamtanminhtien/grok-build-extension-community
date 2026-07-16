import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeVirtualWindow,
  shouldStickToBottom,
} from "./messageVirtualList.ts";

describe("computeVirtualWindow", () => {
  it("returns empty for zero total", () => {
    assert.deepEqual(
      computeVirtualWindow({
        total: 0,
        scrollTop: 0,
        viewportHeight: 400,
        estimatedRowHeight: 80,
      }),
      { start: 0, end: 0 },
    );
  });

  it("windows middle of long list", () => {
    const w = computeVirtualWindow({
      total: 100,
      scrollTop: 800,
      viewportHeight: 400,
      estimatedRowHeight: 80,
      overscan: 2,
    });
    // first visible ~10; start 8; visible 5; end 17
    assert.equal(w.start, 8);
    assert.equal(w.end, 17);
  });
});

describe("shouldStickToBottom", () => {
  it("true near bottom", () => {
    assert.equal(shouldStickToBottom(900, 1000, 100, 48), true);
  });
  it("false when scrolled up", () => {
    assert.equal(shouldStickToBottom(0, 1000, 100, 48), false);
  });
});
