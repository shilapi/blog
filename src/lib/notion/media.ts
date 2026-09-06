import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import {
  limitRemoteRequest,
  maxRetries,
  requestTimeoutMs,
  retryDelay,
} from "./client";
import { asRecord } from "./shared";
import type { UnknownRecord } from "./types";

const mediaPromisesBySource = new Map<string, Promise<string | undefined>>();
const mediaPathsByContentHash = new Map<string, string>();

type HeicConverter = (options: {
  buffer: Buffer<ArrayBufferLike>;
  format: "JPEG";
  quality: number;
}) => Promise<Uint8Array<ArrayBufferLike>>;

// `heic-convert` is CommonJS-only and intentionally loaded server-side.
const heicConvert = createRequire(import.meta.url)(
  "heic-convert",
) as HeicConverter;

function extensionFromUrl(url: string): string {
  try {
    const extension = path.extname(new URL(url).pathname).toLowerCase();
    if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  } catch {
    // Fall through to a safe generic extension.
  }
  return ".bin";
}

function localAssetPath(filename: string): string {
  return path.join(process.cwd(), "public", "notion", filename);
}

/** Ignore the renewed query string on Notion's short-lived signed URLs. */
function mediaSourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function shouldRetry(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

async function fetchNotionMedia(url: string): Promise<Response | undefined> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await limitRemoteRequest(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          return await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
      });
      if (response.ok || !shouldRetry(response)) return response;
      await response.body?.cancel();
    } catch {
      // Network and timeout failures are retried below.
    }

    if (attempt < maxRetries) await retryDelay(attempt);
  }

  return undefined;
}

async function convertHeicToJpeg(
  contents: Buffer<ArrayBufferLike>,
  assetId: string,
): Promise<Buffer<ArrayBufferLike> | undefined> {
  try {
    return await sharp(contents, { failOn: "none" })
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch {
    try {
      return Buffer.from(
        await heicConvert({ buffer: contents, format: "JPEG", quality: 0.9 }),
      );
    } catch {
      console.warn(`跳过无法转换为 JPEG 的 Notion HEIC（资源 ${assetId}）`);
      return undefined;
    }
  }
}

async function persistNotionFile(
  assetId: string,
  url: string,
): Promise<string | undefined> {
  const response = await fetchNotionMedia(url);
  if (!response) {
    console.warn(
      `跳过 Notion 媒体（重试 ${maxRetries} 次后仍无法下载，资源 ${assetId}）`,
    );
    return undefined;
  }
  if (!response.ok) {
    console.warn(
      `跳过 Notion 媒体（资源 ${assetId}，HTTP ${response.status}）`,
    );
    return undefined;
  }

  let contents: Buffer<ArrayBufferLike> = Buffer.from(
    await response.arrayBuffer(),
  );
  let extension = extensionFromUrl(url);

  if (extension === ".heic" || extension === ".heif") {
    const jpeg = await convertHeicToJpeg(contents, assetId);
    if (!jpeg) return undefined;
    contents = jpeg;
    extension = ".jpg";
  }

  const contentHash = createHash("sha256").update(contents).digest("hex");
  const cachedPath = mediaPathsByContentHash.get(contentHash);
  if (cachedPath) return cachedPath;

  const destination = localAssetPath(`${contentHash}${extension}`);
  await mkdir(path.dirname(destination), { recursive: true });
  if (!existsSync(destination)) await writeFile(destination, contents);

  const assetPath = `/notion/${path.basename(destination)}`;
  mediaPathsByContentHash.set(contentHash, assetPath);
  return assetPath;
}

export async function persistFile(
  assetId: string,
  value: UnknownRecord,
): Promise<string | undefined> {
  const fileType = typeof value.type === "string" ? value.type : "";
  const file = asRecord(value[fileType]);
  const url = typeof file?.url === "string" ? file.url : "";
  if (!url) return undefined;
  if (fileType === "external") return url;

  const sourceKey = mediaSourceKey(url);
  const existing = mediaPromisesBySource.get(sourceKey);
  if (existing) return existing;

  const download = persistNotionFile(assetId, url);
  mediaPromisesBySource.set(sourceKey, download);
  return download;
}
