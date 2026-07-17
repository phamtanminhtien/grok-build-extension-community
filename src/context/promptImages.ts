/**
 * Image attachments for ACP prompts — TUI parity (limits/mime/meta)
 * with IDE previews via staged files.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContentBlock } from "@agentclientprotocol/sdk";

/** TUI PromptWidget::IMAGE_CAP */
export const MAX_IMAGES_PER_PROMPT = 10;
/** TUI MAX_SEND_BYTES */
export const MAX_IMAGE_BYTES = 50_000_000;
/** Wrap clipboard path soft cap (webview transfer) */
export const MAX_WEBVIEW_TRANSFER_BYTES = 20 * 1024 * 1024;
export const MIN_IMAGE_DIM = 8;
/** Soft cap for practical JSON-RPC / stdio (decoded bytes per image) */
export const MAX_PRACTICAL_SEND_BYTES = 12_000_000;

export const IMAGE_DISPLAY_NUMBER_META_KEY = "xai.dev/imageDisplayNumber";

export const ALLOWED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
  "tif",
]);

export const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/tiff",
]);

export type ImageSource = "clipboard" | "drop" | "dialog" | "path";

export interface AttachedImage {
  id: string;
  displayNumber: number;
  mimeType: string;
  byteLen: number;
  width?: number;
  height?: number;
  /** Staged absolute path (always set after successful attach). */
  stagedPath: string;
  /** User-visible original path when known (dialog / path paste). */
  sourcePath?: string;
  fileName?: string;
  source: ImageSource;
}

export type AttachRejectReason =
  | "unsupported_type"
  | "too_large"
  | "too_large_transfer"
  | "too_small"
  | "too_many"
  | "unreadable"
  | "corrupt"
  | "empty";

export class AttachImageError extends Error {
  readonly reason: AttachRejectReason;
  constructor(reason: AttachRejectReason, message: string) {
    super(message);
    this.name = "AttachImageError";
    this.reason = reason;
  }
}

export function mimeFromBytes(data: Uint8Array): string {
  if (data.length >= 8 && isPng(data)) {
    return "image/png";
  }
  if (
    data.length >= 3 &&
    data[0] === 0xff &&
    data[1] === 0xd8 &&
    data[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    data.length >= 4 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return "image/webp";
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return "image/bmp";
  }
  if (
    data.length >= 4 &&
    ((data[0] === 0x49 &&
      data[1] === 0x49 &&
      data[2] === 0x2a &&
      data[3] === 0x00) ||
      (data[0] === 0x4d &&
        data[1] === 0x4d &&
        data[2] === 0x00 &&
        data[3] === 0x2a))
  ) {
    return "image/tiff";
  }
  return "application/octet-stream";
}

function isPng(data: Uint8Array): boolean {
  return (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  );
}

export function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "bin";
  }
}

export function isAllowedImagePath(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return ALLOWED_IMAGE_EXTENSIONS.has(ext);
}

/**
 * Best-effort header dimensions. Returns undefined when not parsed.
 */
export function readImageDimensions(
  data: Uint8Array,
  mime: string,
): { width: number; height: number } | undefined {
  try {
    if (mime === "image/png" && data.length >= 24) {
      const width = readU32be(data, 16);
      const height = readU32be(data, 20);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
    if (mime === "image/gif" && data.length >= 10) {
      const width = data[6]! | (data[7]! << 8);
      const height = data[8]! | (data[9]! << 8);
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
    if (mime === "image/bmp" && data.length >= 26) {
      const width = readI32le(data, 18);
      const height = Math.abs(readI32le(data, 22));
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
    if (mime === "image/jpeg") {
      return readJpegDimensions(data);
    }
    if (mime === "image/webp") {
      return readWebpDimensions(data);
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

function readU32be(data: Uint8Array, o: number): number {
  return (
    ((data[o]! << 24) |
      (data[o + 1]! << 16) |
      (data[o + 2]! << 8) |
      data[o + 3]!) >>>
    0
  );
}

function readI32le(data: Uint8Array, o: number): number {
  return (
    data[o]! | (data[o + 1]! << 8) | (data[o + 2]! << 16) | (data[o + 3]! << 24)
  );
}

function readU16be(data: Uint8Array, o: number): number {
  return (data[o]! << 8) | data[o + 1]!;
}

function readJpegDimensions(
  data: Uint8Array,
): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = data[i + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2;
      continue;
    }
    if (i + 4 >= data.length) {
      break;
    }
    const len = readU16be(data, i + 2);
    if (len < 2) {
      break;
    }
    // SOF0–SOF3, SOF5–SOF7, SOF9–SOF11, SOF13–SOF15
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (i + 8 < data.length) {
        const height = readU16be(data, i + 5);
        const width = readU16be(data, i + 7);
        if (width > 0 && height > 0) {
          return { width, height };
        }
      }
      break;
    }
    i += 2 + len;
  }
  return undefined;
}

function readWebpDimensions(
  data: Uint8Array,
): { width: number; height: number } | undefined {
  if (data.length < 30) {
    return undefined;
  }
  // VP8X
  if (
    data[12] === 0x56 &&
    data[13] === 0x50 &&
    data[14] === 0x38 &&
    data[15] === 0x58 &&
    data.length >= 30
  ) {
    const width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16));
    const height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16));
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  // VP8 (lossy)
  if (
    data[12] === 0x56 &&
    data[13] === 0x50 &&
    data[14] === 0x38 &&
    data[15] === 0x20 &&
    data.length >= 30
  ) {
    const width = data[26]! | ((data[27]! & 0x3f) << 8);
    const height = data[28]! | ((data[29]! & 0x3f) << 8);
    if (width > 0 && height > 0) {
      return { width, height };
    }
  }
  return undefined;
}

export function userMessageForReject(reason: AttachRejectReason): string {
  switch (reason) {
    case "unsupported_type":
      return "Unsupported image type (use PNG, JPEG, GIF, WebP, BMP, or TIFF).";
    case "too_large":
      return `Image exceeds ${Math.round(MAX_IMAGE_BYTES / 1_000_000)} MB limit.`;
    case "too_large_transfer":
      return "Clipboard image exceeds 20 MB transfer limit — save to disk and use Attach Image…";
    case "too_small":
      return "Image is smaller than 8×8 pixels.";
    case "too_many":
      return `Maximum ${MAX_IMAGES_PER_PROMPT} images per prompt.`;
    case "unreadable":
      return "Could not read image file.";
    case "corrupt":
      return "File is not a valid image.";
    case "empty":
      return "Image is empty.";
    default:
      return "Could not attach image.";
  }
}

export function validateImageBytes(
  data: Uint8Array,
  opts?: { fromWebviewTransfer?: boolean },
): {
  mimeType: string;
  width?: number;
  height?: number;
} {
  if (!data.length) {
    throw new AttachImageError("empty", userMessageForReject("empty"));
  }
  if (opts?.fromWebviewTransfer && data.length > MAX_WEBVIEW_TRANSFER_BYTES) {
    throw new AttachImageError(
      "too_large_transfer",
      userMessageForReject("too_large_transfer"),
    );
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new AttachImageError("too_large", userMessageForReject("too_large"));
  }
  const mimeType = mimeFromBytes(data);
  if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
    throw new AttachImageError(
      "unsupported_type",
      userMessageForReject("unsupported_type"),
    );
  }
  const dims = readImageDimensions(data, mimeType);
  if (dims && (dims.width < MIN_IMAGE_DIM || dims.height < MIN_IMAGE_DIM)) {
    throw new AttachImageError("too_small", userMessageForReject("too_small"));
  }
  return { mimeType, width: dims?.width, height: dims?.height };
}

export function ensureImagePlaceholders(text: string, count: number): string {
  if (count <= 0) {
    return text;
  }
  let out = text;
  for (let n = 1; n <= count; n++) {
    const token = `[Image #${n}]`;
    if (!out.includes(token)) {
      out = out.trimEnd();
      out = out ? `${out} ${token}` : token;
    }
  }
  return out;
}

/**
 * Dense renumber: rewrite known tokens after remove.
 * `oldNumbers` is the previous 1..N list before renumber (after filter, new length is images.length).
 */
export function renumberComposerTokens(
  text: string,
  previousNumbers: number[],
): string {
  // Map old display numbers → new dense 1..N in order of previousNumbers
  // After remove, previousNumbers is the remaining old numbers in order.
  let out = text;
  // Protect with placeholders to avoid double-rewrite
  const map = new Map<number, number>();
  previousNumbers.forEach((oldN, i) => {
    map.set(oldN, i + 1);
  });
  // Replace higher numbers first to avoid partial collisions
  const sorted = [...map.keys()].sort((a, b) => b - a);
  for (const oldN of sorted) {
    const neu = map.get(oldN)!;
    if (oldN === neu) {
      continue;
    }
    const re = new RegExp(`\\[Image #${oldN}\\]`, "g");
    out = out.replace(re, `[Image #__TMP_${neu}__]`);
  }
  out = out.replace(/\[Image #__TMP_(\d+)__\]/g, "[Image #$1]");
  return out;
}

export async function loadImageBlocksFromDisk(
  images: AttachedImage[],
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const img of images) {
    const buf = await fs.readFile(img.stagedPath);
    if (buf.length > MAX_PRACTICAL_SEND_BYTES) {
      throw new AttachImageError(
        "too_large",
        `Image #${img.displayNumber} is ${Math.round(buf.length / 1_000_000)} MB encoded for send; max practical client size is ${Math.round(MAX_PRACTICAL_SEND_BYTES / 1_000_000)} MB. Try a smaller file.`,
      );
    }
    const data = buf.toString("base64");
    const block: ContentBlock = {
      type: "image",
      data,
      mimeType: img.mimeType,
      _meta: {
        [IMAGE_DISPLAY_NUMBER_META_KEY]: img.displayNumber,
      },
    };
    // Only durable user source paths on the wire (never ephemeral stage path).
    if (img.sourcePath) {
      block.uri = pathToFileURL(img.sourcePath).href;
    }
    blocks.push(block);
  }
  return blocks;
}

export class AttachedImageStore {
  private images: AttachedImage[] = [];
  readonly stagingRoot: string;

  constructor(stagingRoot: string) {
    this.stagingRoot = stagingRoot;
  }

  getAll(): AttachedImage[] {
    return this.images.slice();
  }

  count(): number {
    return this.images.length;
  }

  async ensureStagingDir(): Promise<void> {
    await fs.mkdir(this.stagingRoot, { recursive: true });
  }

  async attachBytes(
    data: Uint8Array,
    opts: {
      source: ImageSource;
      fileName?: string;
      sourcePath?: string;
      fromWebviewTransfer?: boolean;
    },
  ): Promise<AttachedImage> {
    if (this.images.length >= MAX_IMAGES_PER_PROMPT) {
      throw new AttachImageError("too_many", userMessageForReject("too_many"));
    }
    const { mimeType, width, height } = validateImageBytes(data, {
      fromWebviewTransfer: opts.fromWebviewTransfer,
    });
    await this.ensureStagingDir();
    const id = crypto.randomUUID();
    const displayNumber = this.images.length + 1;
    const ext = extensionForMime(mimeType);
    const stagedPath = path.join(this.stagingRoot, `${id}.${ext}`);
    await fs.writeFile(stagedPath, data);
    const img: AttachedImage = {
      id,
      displayNumber,
      mimeType,
      byteLen: data.length,
      width,
      height,
      stagedPath,
      sourcePath: opts.sourcePath,
      fileName:
        opts.fileName ?? path.basename(opts.sourcePath ?? `image.${ext}`),
      source: opts.source,
    };
    this.images.push(img);
    return img;
  }

  async attachFromPath(
    filePath: string,
    source: ImageSource,
  ): Promise<AttachedImage> {
    if (!isAllowedImagePath(filePath)) {
      throw new AttachImageError(
        "unsupported_type",
        userMessageForReject("unsupported_type"),
      );
    }
    let data: Buffer;
    try {
      data = await fs.readFile(filePath);
    } catch {
      throw new AttachImageError(
        "unreadable",
        userMessageForReject("unreadable"),
      );
    }
    return this.attachBytes(data, {
      source,
      sourcePath: filePath,
      fileName: path.basename(filePath),
      fromWebviewTransfer: false,
    });
  }

  /**
   * Remove by id; renumber dense 1..N. Returns remaining images and
   * previous display numbers (for composer token rewrite).
   */
  async remove(id: string): Promise<{
    remaining: AttachedImage[];
    previousNumbers: number[];
  }> {
    const previousNumbers = this.images
      .filter((i) => i.id !== id)
      .map((i) => i.displayNumber);
    const removed = this.images.find((i) => i.id === id);
    this.images = this.images.filter((i) => i.id !== id);
    this.images.forEach((img, i) => {
      img.displayNumber = i + 1;
    });
    // Keep staged file for history if still referenced; for pre-send remove, delete.
    if (removed) {
      try {
        await fs.unlink(removed.stagedPath);
      } catch {
        /* ignore */
      }
    }
    return { remaining: this.getAll(), previousNumbers };
  }

  /** Clear all pre-send attachments (composer). Does not delete history message paths. */
  async clearComposerAttachments(): Promise<void> {
    const copy = this.images.slice();
    this.images = [];
    for (const img of copy) {
      try {
        await fs.unlink(img.stagedPath);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Detach from composer without deleting files (after send — keep for history thumbs).
   * Returns snapshot for the user message.
   */
  takeForSend(): AttachedImage[] {
    const snap = this.images.slice();
    this.images = [];
    return snap;
  }

  async disposeAll(): Promise<void> {
    await this.clearComposerAttachments();
  }
}

export function decodeBase64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

export function parseImagePathsFromText(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  // Only treat as path paste when every non-empty line looks like a path.
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  if (!lines.length) {
    return null;
  }
  const paths: string[] = [];
  for (const line of lines) {
    // Also split whitespace-separated paths on a single line
    const tokens = line.split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      let p = t;
      if (p.startsWith("file://")) {
        try {
          p = fileURLToPath(p);
        } catch {
          return null;
        }
      }
      if (p.startsWith("~/")) {
        p = path.join(
          process.env.HOME || process.env.USERPROFILE || "",
          p.slice(2),
        );
      }
      // Absolute path only (Unix / Windows drive)
      if (
        !(
          p.startsWith("/") ||
          /^[a-zA-Z]:[\\/]/.test(p) ||
          p.startsWith("\\\\")
        )
      ) {
        return null;
      }
      paths.push(p);
    }
  }
  if (!paths.length) {
    return null;
  }
  // At least one image path
  if (!paths.some(isAllowedImagePath)) {
    return null;
  }
  return paths;
}
