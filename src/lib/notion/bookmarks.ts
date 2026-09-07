import { textFromRichText } from "./shared";
import type { BookmarkPreview, UnknownRecord } from "./types";

const metadataCache = new Map<string, Promise<BookmarkPreview>>();
const metadataLimit = 256 * 1024;
const metadataTimeoutMs = 4_500;

function decodeHtml(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  };

  return value
    .replace(/&#(\d+);/g, (entity, code: string) => {
      const value = Number.parseInt(code, 10);
      return value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : entity;
    })
    .replace(/&#x([\da-f]+);/gi, (entity, code: string) => {
      const value = Number.parseInt(code, 16);
      return value >= 0 && value <= 0x10ffff
        ? String.fromCodePoint(value)
        : entity;
    })
    .replace(
      /&([a-z]+);/gi,
      (entity, name: string) => namedEntities[name.toLowerCase()] ?? entity,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMetadata(value: string, maximumLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maximumLength).trim();
}

function tagAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeHtml(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
  }
  return attributes;
}

function metaContent(html: string, keys: string[]): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = tagAttributes(tag);
    const name = (attributes.property || attributes.name || "").toLowerCase();
    if (keys.includes(name) && attributes.content) return attributes.content;
  }
  return "";
}

function pageTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? decodeHtml(match[1].replace(/<[^>]+>/g, "")) : "";
}

function faviconFromHtml(html: string, pageUrl: URL): string {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = tagAttributes(tag);
    const rel = (attributes.rel ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("icon") || !attributes.href) continue;
    try {
      return new URL(attributes.href, pageUrl).toString();
    } catch {
      // Try the next icon candidate.
    }
  }
  return new URL("/favicon.ico", pageUrl.origin).toString();
}

function fallbackTitle(url: URL): string {
  const segment = decodeURIComponent(
    url.pathname.split("/").filter(Boolean)[0] ?? "",
  );
  if ((url.hostname === "x.com" || url.hostname === "twitter.com") && segment) {
    return `@${segment.replace(/^@/, "")} · X`;
  }
  if (url.hostname === "github.com" && segment) return `${segment} · GitHub`;
  return url.hostname.replace(/^www\./, "");
}

function fallbackDescription(url: URL, caption: string): string {
  if (caption) return caption;
  const path = decodeURIComponent(url.pathname).replace(/\/$/, "");
  return `${url.hostname.replace(/^www\./, "")}${path}`;
}

async function limitedHtml(response: Response): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let html = "";

  while (size < metadataLimit) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (/<\/head\s*>/i.test(html)) break;
  }
  await reader.cancel().catch(() => undefined);
  return html + decoder.decode();
}

async function loadBookmarkPreview(
  rawUrl: string,
  caption: string,
): Promise<BookmarkPreview> {
  const url = new URL(rawUrl);
  const fallback: BookmarkPreview = {
    title: fallbackTitle(url),
    description: fallbackDescription(url, caption),
    faviconUrl: new URL("/favicon.ico", url.origin).toString(),
    hostname: url.hostname.replace(/^www\./, ""),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), metadataTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; shilapi-blog/1.0)",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (
      !response.ok ||
      !response.headers.get("content-type")?.includes("text/html")
    ) {
      await response.body?.cancel();
      return fallback;
    }

    const html = await limitedHtml(response);
    const finalUrl = new URL(response.url || url);
    return {
      title: cleanMetadata(
        metaContent(html, ["og:title", "twitter:title"]) ||
          pageTitle(html) ||
          fallback.title,
        180,
      ),
      description: cleanMetadata(
        caption ||
          metaContent(html, [
            "og:description",
            "twitter:description",
            "description",
          ]) ||
          fallback.description,
        360,
      ),
      faviconUrl: faviconFromHtml(html, finalUrl),
      hostname: finalUrl.hostname.replace(/^www\./, ""),
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

export function bookmarkUrl(data: UnknownRecord): string {
  return typeof data.url === "string" ? data.url : "";
}

export function getBookmarkPreview(
  data: UnknownRecord,
): Promise<BookmarkPreview | undefined> {
  const rawUrl = bookmarkUrl(data);
  if (!rawUrl) return Promise.resolve(undefined);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return Promise.resolve(undefined);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return Promise.resolve(undefined);
  }

  const caption = textFromRichText(data.caption);
  const cacheKey = `${url.toString()}\n${caption}`;
  const cached = metadataCache.get(cacheKey);
  if (cached) return cached;

  const preview = loadBookmarkPreview(url.toString(), caption);
  metadataCache.set(cacheKey, preview);
  return preview;
}
