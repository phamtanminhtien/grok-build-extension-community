import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  ALLOWED_IMAGE_MIMES,
  AttachedImageStore,
  AttachImageError,
  decodeBase64ToBytes,
  ensureImagePlaceholders,
  IMAGE_DISPLAY_NUMBER_META_KEY,
  isAllowedImagePath,
  loadImageBlocksFromDisk,
  MAX_IMAGES_PER_PROMPT,
  mimeFromBytes,
  parseImagePathsFromText,
  readImageDimensions,
  renumberComposerTokens,
  validateImageBytes,
} from "./promptImages.ts";

/** Minimal valid 8×8 PNG (solid black). */
function png8x8(): Uint8Array {
  // Pre-generated 8x8 black PNG
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVQYV2P8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  return decodeBase64ToBytes(b64);
}

describe("mimeFromBytes", () => {
  it("detects PNG", () => {
    assert.equal(mimeFromBytes(png8x8()), "image/png");
  });
  it("detects JPEG magic", () => {
    assert.equal(
      mimeFromBytes(new Uint8Array([0xff, 0xd8, 0xff, 0x00])),
      "image/jpeg",
    );
  });
  it("rejects unknown", () => {
    assert.equal(
      mimeFromBytes(new Uint8Array([0, 1, 2])),
      "application/octet-stream",
    );
  });
});

describe("validateImageBytes", () => {
  it("accepts valid PNG", () => {
    const v = validateImageBytes(png8x8());
    assert.equal(v.mimeType, "image/png");
    assert.ok(ALLOWED_IMAGE_MIMES.has(v.mimeType));
  });
  it("rejects empty", () => {
    assert.throws(
      () => validateImageBytes(new Uint8Array()),
      (e) => {
        return e instanceof AttachImageError && e.reason === "empty";
      },
    );
  });
  it("rejects non-image", () => {
    assert.throws(
      () => validateImageBytes(new TextEncoder().encode("not an image")),
      (e) => e instanceof AttachImageError && e.reason === "unsupported_type",
    );
  });
});

describe("readImageDimensions", () => {
  it("reads PNG IHDR", () => {
    const d = readImageDimensions(png8x8(), "image/png");
    assert.deepEqual(d, { width: 8, height: 8 });
  });
});

describe("ensureImagePlaceholders / renumber", () => {
  it("appends missing tokens", () => {
    assert.equal(ensureImagePlaceholders("", 2), "[Image #1] [Image #2]");
    assert.equal(ensureImagePlaceholders("hi", 1), "hi [Image #1]");
    assert.equal(ensureImagePlaceholders("x [Image #1]", 1), "x [Image #1]");
  });
  it("renumbers after remove", () => {
    // remaining old numbers were 1 and 3 → become 1 and 2
    const text = "see [Image #1] and [Image #3]";
    assert.equal(
      renumberComposerTokens(text, [1, 3]),
      "see [Image #1] and [Image #2]",
    );
  });
});

describe("isAllowedImagePath / parseImagePathsFromText", () => {
  it("allows raster extensions", () => {
    assert.equal(isAllowedImagePath("/tmp/a.PNG"), true);
    assert.equal(isAllowedImagePath("/tmp/a.svg"), false);
  });
  it("parses absolute path lines", () => {
    const p = parseImagePathsFromText("/tmp/shot.png\n/tmp/other.jpg");
    assert.deepEqual(p, ["/tmp/shot.png", "/tmp/other.jpg"]);
  });
  it("falls through for prose", () => {
    assert.equal(parseImagePathsFromText("look at /tmp/a.png please"), null);
  });
});

describe("AttachedImageStore + loadImageBlocksFromDisk", () => {
  it("stages, renumbers, builds ACP image blocks without staged uri", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-img-"));
    const store = new AttachedImageStore(root);
    const a = await store.attachBytes(png8x8(), { source: "clipboard" });
    assert.equal(a.displayNumber, 1);
    assert.equal(store.count(), 1);

    const b = await store.attachBytes(png8x8(), {
      source: "path",
      sourcePath: "/Users/me/shot.png",
      fileName: "shot.png",
    });
    assert.equal(b.displayNumber, 2);
    assert.equal(b.sourcePath, "/Users/me/shot.png");

    const blocks = await loadImageBlocksFromDisk(store.getAll());
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.type, "image");
    if (blocks[0]!.type === "image") {
      assert.equal(blocks[0].mimeType, "image/png");
      assert.ok(blocks[0].data.length > 0);
      assert.equal(blocks[0].uri, undefined); // clipboard — no uri
      assert.equal(
        (blocks[0]._meta as Record<string, unknown>)?.[
          IMAGE_DISPLAY_NUMBER_META_KEY
        ],
        1,
      );
    }
    if (blocks[1]!.type === "image") {
      assert.ok(blocks[1].uri?.includes("shot.png"));
    }

    await store.remove(a.id);
    assert.equal(store.count(), 1);
    assert.equal(store.getAll()[0]!.displayNumber, 1);

    await store.disposeAll();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("enforces max count", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "grok-img-"));
    const store = new AttachedImageStore(root);
    for (let i = 0; i < MAX_IMAGES_PER_PROMPT; i++) {
      await store.attachBytes(png8x8(), { source: "clipboard" });
    }
    await assert.rejects(
      () => store.attachBytes(png8x8(), { source: "clipboard" }),
      (e) => e instanceof AttachImageError && e.reason === "too_many",
    );
    await store.disposeAll();
    await fs.rm(root, { recursive: true, force: true });
  });
});
