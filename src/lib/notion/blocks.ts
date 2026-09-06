import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBookmarkPreview } from "./bookmarks";
import { notion, requestNotion } from "./client";
import { persistFile } from "./media";
import { asRecord } from "./shared";
import type { NotionBlock } from "./types";

function normalizeBlock(raw: unknown): NotionBlock | null {
  const record = asRecord(raw);
  if (
    !record ||
    typeof record.id !== "string" ||
    typeof record.type !== "string"
  ) {
    return null;
  }

  return {
    id: record.id,
    type: record.type,
    hasChildren: record.has_children === true,
    data: asRecord(record[record.type]) ?? {},
  };
}

async function fetchRawBlocks(blockId: string): Promise<unknown[]> {
  const client = notion;
  if (!client) return [];

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
      client.blocks.children.list({
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
  const client = notion;
  const fileType = typeof block.data.type === "string" ? block.data.type : "";
  const file = asRecord(block.data[fileType]);
  if (fileType !== "file" || typeof file?.url !== "string") return;

  const expiry =
    typeof file.expiry_time === "string" ? Date.parse(file.expiry_time) : 0;
  if (!expiry || expiry > Date.now() + 60_000 || !client) return;

  const refreshed = asRecord(
    await requestNotion(() => client.blocks.retrieve({ block_id: block.id })),
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
        block.assetUrl = await persistFile(block.id, block.data);
      }

      if (block.type === "bookmark" || block.type === "link_preview") {
        block.bookmarkPreview = await getBookmarkPreview(block.data);
      }

      if (block.hasChildren) {
        block.children = await buildBlockTree(
          await fetchRawBlocks(block.id),
          seen,
        );
      }

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
