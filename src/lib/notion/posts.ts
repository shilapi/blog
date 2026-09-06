import { Client, isFullPage, type PageObjectResponse } from "@notionhq/client";
import { posts as localPosts, type Post } from "../../data/posts";
import { dataSourceId, notion, notionToken, requestNotion } from "./client";
import { persistFile } from "./media";
import { asRecord, textFromRichText } from "./shared";
import type { UnknownRecord } from "./types";

type DataSourceQueryResult = Awaited<
  ReturnType<Client["dataSources"]["query"]>
>["results"][number];

let postsBuildCache: Promise<Post[]> | undefined;

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

  if (!slug || !title || status === "private" || !type) return null;

  const excerpt =
    textProperty(properties, "Summary") || textProperty(properties, "Excerpt");
  const featuredFile =
    firstFileProperty(properties, "FeaturedImage") || asRecord(page.cover);

  return {
    slug,
    type,
    title,
    excerpt,
    date: dateProperty(properties, "Date") || page.created_time.slice(0, 10),
    tags: tagsProperty(properties, "Tags"),
    content: textProperty(properties, "Content") || excerpt,
    sourceId: page.id,
    featuredImage: featuredFile
      ? await persistFile(`${page.id}-featured`, featuredFile)
      : undefined,
  };
}

async function fetchPosts(): Promise<Post[]> {
  const client = notion;
  if (!notionToken || !dataSourceId || !client) return localPosts;

  try {
    const results: DataSourceQueryResult[] = [];
    let startCursor: string | undefined;
    do {
      const response = await requestNotion(() =>
        client.dataSources.query({
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

/** Reuse the publication list while one production build generates routes. */
export function getPosts(): Promise<Post[]> {
  if (!import.meta.env.PROD) return fetchPosts();

  postsBuildCache ??= fetchPosts().catch((error: unknown) => {
    postsBuildCache = undefined;
    throw error;
  });
  return postsBuildCache;
}
