import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Client, isFullPage, type PageObjectResponse } from "@notionhq/client";
import sharp from "sharp";
import { posts as localPosts, type Post } from "../data/posts";

type UnknownRecord = Record<string, unknown>;
type DataSourceQueryResult = Awaited<
  ReturnType<Client["dataSources"]["query"]>
>["results"][number];

/** The small, renderer-friendly shape used by our Astro components. */
export interface NotionBlock {
  id: string;
  type: string;
  hasChildren: boolean;
  data: UnknownRecord;
  children?: NotionBlock[];
  /** A Notion-hosted file is copied to /public/notion during the build. */
  assetUrl?: string;
}

const notionToken = import.meta.env.NOTION_TOKEN;
const dataSourceId = import.meta.env.NOTION_DATA_SOURCE_ID;
const mediaRequestTimeoutMs = 15_000;
const mediaMaxRetries = 3;
const mediaMaxRetryDelayMs = 5_000;
const remoteRequestConcurrency = 3;

function createRequestLimiter(maxConcurrent: number) {
  let activeRequests = 0;
  const waitingRequests: Array<() => void> = [];

  return function limitRequest<T>(request: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        activeRequests += 1;
        void request()
          .then(resolve, reject)
          .finally(() => {
            activeRequests -= 1;
            waitingRequests.shift()?.();
          });
      };

      if (activeRequests < maxConcurrent) {
        run();
      } else {
        waitingRequests.push(run);
      }
    });
  };
}

// All Notion API calls and hosted-media downloads share this limit.
const limitRemoteRequest = createRequestLimiter(remoteRequestConcurrency);
let postsBuildCache: Promise<Post[]> | undefined;
const mediaPromisesBySource = new Map<string, Promise<string | undefined>>();
const mediaPathsByContentHash = new Map<string, string>();

type HeicConverter = (options: {
  buffer: Buffer<ArrayBufferLike>;
  format: "JPEG";
  quality: number;
}) => Promise<Uint8Array<ArrayBufferLike>>;

// `heic-convert` is CommonJS-only and intentionally loaded server-side. It
// gives us a second HEIC decoder when the native libheif codec rejects a file.
const heicConvert = createRequire(import.meta.url)(
  "heic-convert",
) as HeicConverter;

const notion = notionToken
  ? new Client({
      auth: notionToken,
      notionVersion: "2026-03-11",
      timeoutMs: 15_000,
      retry: { maxRetries: 3, maxRetryDelayMs: 5_000 },
    })
  : null;

async function requestNotion<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= mediaMaxRetries; attempt += 1) {
    try {
      return await limitRemoteRequest(request);
    } catch (error) {
      lastError = error;
      if (attempt < mediaMaxRetries) {
        const delay = Math.min(1_000 * 2 ** attempt, mediaMaxRetryDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

export function textFromRichText(value: unknown): string {
  if (!Array.isArray(value)) return "";

  return value
    .map((item) => {
      const record = asRecord(item);
      if (!record) return "";
      if (typeof record.plain_text === "string") return record.plain_text;
      const text = asRecord(record.text);
      return typeof text?.content === "string" ? text.content : "";
    })
    .join("");
}

function propertyValue(
  properties: PageObjectResponse["properties"],
  name: string,
): unknown {
  const exact = properties[name];
  if (exact) return exact;

  const matchingName = Object.keys(properties).find(
    (propertyName) => propertyName.toLowerCase() === name.toLowerCase(),
  );
  return matchingName ? properties[matchingName] : undefined;
}

function textProperty(
  properties: PageObjectResponse["properties"],
  name: string,
): string {
  const property = asRecord(propertyValue(properties, name));
  return textFromRichText(property?.title ?? property?.rich_text);
}

function dateProperty(
  properties: PageObjectResponse["properties"],
  name: string,
): string {
  const property = asRecord(propertyValue(properties, name));
  const date = asRecord(property?.date);
  return typeof date?.start === "string" ? date.start : "";
}

function tagsProperty(
  properties: PageObjectResponse["properties"],
  name: string,
): string[] {
  const property = asRecord(propertyValue(properties, name));
  if (!Array.isArray(property?.multi_select)) return [];

  return property.multi_select.flatMap((tag) => {
    const tagRecord = asRecord(tag);
    return typeof tagRecord?.name === "string" ? [tagRecord.name] : [];
  });
}

function selectProperty(
  properties: PageObjectResponse["properties"],
  name: string,
): string {
  const property = asRecord(propertyValue(properties, name));
  const option = asRecord(property?.select) ?? asRecord(property?.status);
  return typeof option?.name === "string" ? option.name : "";
}

function firstFileProperty(
  properties: PageObjectResponse["properties"],
  name: string,
): UnknownRecord | null {
  const property = asRecord(propertyValue(properties, name));
  if (!Array.isArray(property?.files)) return null;
  return asRecord(property.files[0]);
}

async function pageToPost(page: PageObjectResponse): Promise<Post | null> {
  const { properties } = page;
  const slug = textProperty(properties, "Slug");
  const title =
    textProperty(properties, "Title") || textProperty(properties, "Name");
  const status = selectProperty(properties, "Status").toLowerCase();
  const configuredType = selectProperty(properties, "Type").toLowerCase();
  const type =
    configuredType === "post"
      ? "Post"
      : configuredType === "paper"
        ? "Paper"
        : null;

  if (!slug || !title || status === "private" || !type) {
    return null;
  }

  const excerpt =
    textProperty(properties, "Summary") || textProperty(properties, "Excerpt");

  const featuredFile =
    firstFileProperty(properties, "FeaturedImage") || asRecord(page.cover);
  const featuredImage = featuredFile
    ? await persistFile(`${page.id}-featured`, featuredFile)
    : undefined;

  return {
    slug,
    type,
    title,
    excerpt,
    date: dateProperty(properties, "Date") || page.created_time.slice(0, 10),
    tags: tagsProperty(properties, "Tags"),
    // This remains a useful fallback while a page has no readable blocks.
    content: textProperty(properties, "Content") || excerpt,
    sourceId: page.id,
    featuredImage,
  };
}

function normalizeBlock(raw: unknown): NotionBlock | null {
  const record = asRecord(raw);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.type !== "string"
  ) {
    return null;
  }

  const data = asRecord(record[record.type]) ?? {};
  return {
    id: record.id,
    type: record.type,
    hasChildren: record.has_children === true,
    data,
  };
}

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

/**
 * Notion renews the query string on signed URLs. The path identifies the same
 * underlying file, so ignore that short-lived portion while a build runs.
 */
function mediaSourceKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function shouldRetryMediaResponse(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

async function fetchNotionMedia(url: string): Promise<Response | undefined> {
  for (let attempt = 0; attempt <= mediaMaxRetries; attempt += 1) {
    try {
      const response = await limitRemoteRequest(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          mediaRequestTimeoutMs,
        );
        try {
          return await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timeout);
        }
      });
      if (response.ok || !shouldRetryMediaResponse(response)) return response;

      // Free the failed response before attempting a new connection.
      await response.body?.cancel();
    } catch {
      // Network and timeout failures are retried below.
    }

    if (attempt < mediaMaxRetries) {
      const delay = Math.min(1_000 * 2 ** attempt, mediaMaxRetryDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
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
      // Do not make every route fail because a single damaged or unsupported
      // HEIC file cannot be decoded. Avoid logging its signed source URL.
      console.warn(`跳过无法转换为 JPEG 的 Notion HEIC（资源 ${assetId}）`);
      return undefined;
    }
  }
}

async function persistFile(
  assetId: string,
  value: UnknownRecord,
): Promise<string | undefined> {
  const fileType = typeof value.type === "string" ? value.type : "";
  const file = asRecord(value[fileType]);
  const url = typeof file?.url === "string" ? file.url : "";
  if (!url) return undefined;

  // External URLs are already durable; only Notion-hosted files need copying.
  if (fileType === "external") {
    return url;
  }

  const sourceKey = mediaSourceKey(url);
  const existing = mediaPromisesBySource.get(sourceKey);
  if (existing) return existing;

  const download = persistNotionFile(assetId, url);
  mediaPromisesBySource.set(sourceKey, download);
  return download;
}

async function persistNotionFile(
  assetId: string,
  url: string,
): Promise<string | undefined> {
  const response = await fetchNotionMedia(url);
  if (!response) {
    console.warn(
      `跳过 Notion 媒体（重试 ${mediaMaxRetries} 次后仍无法下载，资源 ${assetId}）`,
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

  // Browsers do not consistently render HEIC/HEIF. Convert hosted Notion
  // files while building so all generated markup points at a web-safe JPEG.
  if (extension === ".heic" || extension === ".heif") {
    const jpeg = await convertHeicToJpeg(contents, assetId);
    if (!jpeg) return undefined;
    contents = jpeg;
    extension = ".jpg";
  }

  // Naming by final bytes guarantees that distinct Notion URLs for the same
  // image share one output file. The map also avoids repeated writes during
  // concurrent page rendering.
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

async function persistAsset(block: NotionBlock): Promise<void> {
  block.assetUrl = await persistFile(block.id, block.data);
}

async function fetchRawBlocks(blockId: string): Promise<unknown[]> {
  if (!notion) return [];

  // Optional build cache: useful for rate limits, but disabled by default so
  // edits in Notion are visible on the next build.
  const useCache =
    process.env.NOTION_BLOCK_CACHE === "true" && import.meta.env.PROD;
  const cachePath = path.join(process.cwd(), "tmp", `${blockId}.json`);
  if (useCache && existsSync(cachePath)) {
    return JSON.parse(await readFile(cachePath, "utf8")) as unknown[];
  }

  const results: unknown[] = [];
  let startCursor: string | undefined;
  do {
    const response = await requestNotion(() =>
      notion.blocks.children.list({
        block_id: blockId,
        page_size: 100,
        ...(startCursor ? { start_cursor: startCursor } : {}),
      }),
    );
    results.push(...response.results);
    startCursor = response.has_more
      ? (response.next_cursor ?? undefined)
      : undefined;
  } while (startCursor);

  if (useCache) {
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(results));
  }
  return results;
}

async function refreshExpiringAsset(block: NotionBlock): Promise<void> {
  const data = block.data;
  const fileType = typeof data.type === "string" ? data.type : "";
  const file = asRecord(data[fileType]);
  if (fileType !== "file" || typeof file?.url !== "string") return;

  const expiry =
    typeof file.expiry_time === "string" ? Date.parse(file.expiry_time) : 0;
  if (!expiry || expiry > Date.now() + 60_000 || !notion) return;

  const refreshed = asRecord(
    await requestNotion(() => notion.blocks.retrieve({ block_id: block.id })),
  );
  const freshPayload = asRecord(refreshed?.[block.type]);
  if (freshPayload) block.data = freshPayload;
}

async function buildBlockTree(
  rawBlocks: unknown[],
  seen: Set<string>,
): Promise<NotionBlock[]> {
  const blocks = rawBlocks.flatMap((raw) => {
    const block = normalizeBlock(raw);
    if (!block || seen.has(block.id)) return [];
    seen.add(block.id);
    return [block];
  });

  return Promise.all(
    blocks.map(async (block) => {
      await refreshExpiringAsset(block);
      if (
        block.type === "image" ||
        block.type === "file" ||
        block.type === "video" ||
        block.type === "audio" ||
        block.type === "pdf"
      ) {
        await persistAsset(block);
      }

      if (block.hasChildren) {
        block.children = await buildBlockTree(
          await fetchRawBlocks(block.id),
          seen,
        );
      }

      // Synced blocks point to the source block rather than exposing children.
      const synced = asRecord(block.data.synced_from);
      if (
        block.type === "synced_block" &&
        typeof synced?.block_id === "string"
      ) {
        block.children = await buildBlockTree(
          await fetchRawBlocks(synced.block_id),
          seen,
        );
      }

      return block;
    }),
  );
}

/** Fetch a page's complete, recursively nested Notion block tree. */
export async function getPageBlocks(pageId: string): Promise<NotionBlock[]> {
  if (!notion) return [];
  return buildBlockTree(await fetchRawBlocks(pageId), new Set<string>());
}

/** Read non-private posts from Notion, with local examples as an offline fallback. */
async function fetchPosts(): Promise<Post[]> {
  if (!notionToken || !dataSourceId || !notion) return localPosts;

  try {
    const results: DataSourceQueryResult[] = [];
    let startCursor: string | undefined;
    do {
      const response = await requestNotion(() =>
        notion.dataSources.query({
          data_source_id: dataSourceId,
          page_size: 100,
          ...(startCursor ? { start_cursor: startCursor } : {}),
        }),
      );
      results.push(...response.results);
      startCursor = response.has_more
        ? (response.next_cursor ?? undefined)
        : undefined;
    } while (startCursor);

    const posts = await Promise.all(
      results.filter(isFullPage).map((page) => pageToPost(page)),
    );
    return posts
      .filter((post): post is Post => post !== null)
      .filter((post) => post.date <= new Date().toISOString().slice(0, 10))
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    throw new Error(
      `Notion 查询失败：${message}\n请检查 Token、Data Source ID、数据库授权，以及 status/date 等属性名称。`,
    );
  }
}

/** Reuse the publication list while one production build generates its routes. */
export function getPosts(): Promise<Post[]> {
  if (!import.meta.env.PROD) return fetchPosts();

  postsBuildCache ??= fetchPosts().catch((error: unknown) => {
    postsBuildCache = undefined;
    throw error;
  });
  return postsBuildCache;
}
