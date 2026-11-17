import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

// Workers Builds restores node_modules/.astro when Build cache is enabled.
// Bump the version if media conversion settings or the index format change.
const mediaCacheDirectory = path.join(
  process.cwd(),
  "node_modules",
  ".astro",
  "notion-media",
  "v1",
);

function sourceCachePath(sourceKey: string): string {
  const key = createHash("sha256").update(sourceKey).digest("hex");
  return path.join(mediaCacheDirectory, "sources", `${key}.json`);
}

async function writeAtomically(
  destination: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function restoreCachedMedia(
  sourceKey: string,
): Promise<string | undefined> {
  let filename: string;
  let contents: Buffer<ArrayBufferLike>;
  try {
    const entry = asRecord(
      JSON.parse(await readFile(sourceCachePath(sourceKey), "utf8")),
    );
    if (
      typeof entry?.filename !== "string" ||
      !/^[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(entry.filename)
    ) {
      return undefined;
    }
    filename = entry.filename;
    contents = await readFile(
      path.join(mediaCacheDirectory, "files", filename),
    );
    const hash = createHash("sha256").update(contents).digest("hex");
    if (hash !== filename.split(".")[0]) return undefined;
  } catch {
    // Missing, incomplete, or corrupt caches fall back to a fresh download.
    return undefined;
  }

  const destination = localAssetPath(filename);
  await mkdir(path.dirname(destination), { recursive: true });
  if (!existsSync(destination)) await writeFile(destination, contents);
  const assetPath = `/notion/${filename}`;
  mediaPathsByContentHash.set(filename.slice(0, 64), assetPath);
  return assetPath;
}

async function cacheMedia(
  sourceKey: string,
  filename: string,
  contents: Uint8Array,
): Promise<void> {
  try {
    // Publish the index only after the complete, converted file is available.
    await writeAtomically(
      path.join(mediaCacheDirectory, "files", filename),
      contents,
    );
    await writeAtomically(
      sourceCachePath(sourceKey),
      JSON.stringify({ filename }),
    );
  } catch {
    console.warn("无法写入 Notion 媒体缓存；本次构建仍使用已下载的文件。");
  }
}

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
  sourceKey: string,
): Promise<string | undefined> {
  const restored = await restoreCachedMedia(sourceKey);
  if (restored) return restored;

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
  const filename = cachedPath
    ? path.basename(cachedPath)
    : `${contentHash}${extension}`;
  const destination = localAssetPath(filename);
  await mkdir(path.dirname(destination), { recursive: true });
  if (!existsSync(destination)) await writeFile(destination, contents);

  const assetPath = `/notion/${path.basename(destination)}`;
  mediaPathsByContentHash.set(contentHash, assetPath);
  await cacheMedia(sourceKey, filename, contents);
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

  const download = persistNotionFile(assetId, url, sourceKey);
  mediaPromisesBySource.set(sourceKey, download);
  return download;
}
