import type { NotionBlock } from "./notion";
import { asRecord, textFromRichText } from "./notion/shared";

export interface NotionHeadingEntry {
  id: string;
  text: string;
  level: 1 | 2;
}

export function groupNotionLists(blocks: NotionBlock[]): NotionBlock[] {
  const grouped: NotionBlock[] = [];

  for (const block of blocks) {
    const listType =
      block.type === "bulleted_list_item"
        ? "bulleted_list"
        : block.type === "numbered_list_item"
          ? "numbered_list"
          : block.type === "to_do"
            ? "to_do_list"
            : null;

    if (!listType) {
      grouped.push(block);
      continue;
    }

    const previous = grouped.at(-1);
    if (previous?.type === listType) {
      previous.children = [...(previous.children ?? []), block];
      continue;
    }

    grouped.push({
      id: `${block.id}-list`,
      type: listType,
      hasChildren: true,
      data: {},
      children: [block],
    });
  }

  return grouped;
}

export function notionHeadings(blocks: NotionBlock[]): NotionBlock[] {
  return blocks.flatMap((block) => [
    ...(["heading_1", "heading_2", "heading_3"].includes(block.type)
      ? [block]
      : []),
    ...(block.children ? notionHeadings(block.children) : []),
  ]);
}

export function notionHeadingId(value: string, fallbackId: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const stableSuffix = fallbackId.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return [slug || "section", stableSuffix].filter(Boolean).join("-");
}

export function notionHeadingEntries(
  blocks: NotionBlock[],
): NotionHeadingEntry[] {
  return notionHeadings(blocks).flatMap((block) => {
    if (block.type !== "heading_1" && block.type !== "heading_2") return [];
    const text = textFromRichText(block.data.rich_text).trim();
    if (!text) return [];
    return [
      {
        id: notionHeadingId(text, block.id),
        text,
        level: block.type === "heading_1" ? 1 : 2,
      } satisfies NotionHeadingEntry,
    ];
  });
}

export function linkFromNotionData(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.url === "string") return record.url;
  const external = asRecord(record.external);
  return typeof external?.url === "string" ? external.url : "";
}

export function notionIconText(value: unknown): string {
  const icon = asRecord(value);
  return typeof icon?.emoji === "string" ? icon.emoji : "💡";
}

export function notionCellRichText(cell: unknown): unknown[] {
  return Array.isArray(cell) ? cell : [];
}

export function youTubeEmbedUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      return url.pathname.slice(1)
        ? `https://www.youtube.com/embed/${url.pathname.slice(1)}`
        : undefined;
    }
    if (
      url.hostname === "youtube.com" ||
      url.hostname.endsWith(".youtube.com")
    ) {
      const id = url.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${id}` : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
