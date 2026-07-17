import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SnapshotStore } from "./snapshotStore.ts";

describe("SnapshotStore", () => {
  it("captures and returns content", () => {
    const s = new SnapshotStore();
    s.capture("/a/b.ts", "hello");
    assert.equal(s.get("/a/b.ts"), "hello");
  });

  it("normalizes slashes", () => {
    const s = new SnapshotStore();
    s.capture("C:\\x\\y.ts", "z");
    assert.equal(s.get("C:/x/y.ts"), "z");
  });

  it("caps large content", () => {
    const s = new SnapshotStore(10);
    s.capture("/f", "0123456789ABCDEF");
    assert.equal(s.get("/f"), "0123456789");
  });

  it("deletes a single path", () => {
    const s = new SnapshotStore();
    s.capture("/a.ts", "a");
    s.capture("/b.ts", "b");
    assert.equal(s.delete("/a.ts"), true);
    assert.equal(s.has("/a.ts"), false);
    assert.equal(s.get("/b.ts"), "b");
  });
});
