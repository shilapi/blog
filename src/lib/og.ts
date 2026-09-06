import type { Post } from "../data/posts";
import sharp, { type OverlayOptions } from "sharp";

export const ogImageWidth = 1200;
export const ogImageHeight = 630;

export interface OgImageData {
  title: string;
  description: string;
  thumbnail?: string;
}

export function ogImageKey(post: Post): string {
  const slug =
    post.slug
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "page";
  return `${post.type.toLowerCase()}-${slug}`;
}

function escapeMarkup(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function characterWidth(character: string): number {
  if (/\s/.test(character)) return 0.35;
  if (/^[\x00-\xff]$/.test(character)) return 0.58;
  return 1;
}

function wrapText(
  value: string,
  maximumWidth: number,
  maximumLines: number,
): string[] {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const lines: string[] = [];
  let current = "";
  let width = 0;
  let truncated = false;

  for (const character of normalized) {
    const nextWidth = width + characterWidth(character);
    if (current && nextWidth > maximumWidth) {
      if (lines.length >= maximumLines - 1) {
        truncated = true;
        break;
      }
      const breakAt = current.lastIndexOf(" ");
      if (breakAt > current.length * 0.55) {
        lines.push(current.slice(0, breakAt));
        current = `${current.slice(breakAt + 1)}${character}`;
        width = [...current].reduce(
          (sum, item) => sum + characterWidth(item),
          0,
        );
      } else {
        lines.push(current);
        current = character.trimStart();
        width = characterWidth(character);
      }
      continue;
    }
    current += character;
    width = nextWidth;
  }

  if (current) lines.push(current);
  if (lines.length > maximumLines) lines.length = maximumLines;

  if (truncated && lines.length > 0) {
    lines[lines.length - 1] =
      `${lines[lines.length - 1].replace(/[.。…\s]+$/u, "")}…`;
  }
  return lines;
}

function fadeOverlay(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 4);
  for (let x = 0; x < width; x += 1) {
    const progress = x / Math.max(width - 1, 1);
    const alpha = Math.round(255 * Math.pow(1 - progress, 1.35));
    for (let y = 0; y < height; y += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = 9;
      pixels[offset + 1] = 7;
      pixels[offset + 2] = 15;
      pixels[offset + 3] = alpha;
    }
  }
  return pixels;
}

function textLayer(
  value: string,
  options: {
    color: string;
    fontFile: string;
    fontSize: number;
    fontWeight: 400 | 600;
    height: number;
    left: number;
    top: number;
    width: number;
  },
): OverlayOptions {
  return {
    input: {
      text: {
        text: `<span foreground="${options.color}" font_weight="${options.fontWeight}">${escapeMarkup(value)}</span>`,
        font: `Pretendard ${options.fontSize}`,
        fontfile: options.fontFile,
        width: options.width,
        height: options.height,
        rgba: true,
      },
    },
    left: options.left,
    top: options.top,
  };
}

export async function renderOgImage(
  data: OgImageData,
  options: {
    regularFontPath: string;
    semiboldFontPath: string;
    thumbnail?: Buffer;
  },
): Promise<Buffer> {
  const hasThumbnail = Boolean(options.thumbnail);
  const titleLines = wrapText(data.title, hasThumbnail ? 19 : 34, 2);
  const descriptionLines = wrapText(
    data.description,
    hasThumbnail ? 30 : 52,
    2,
  );
  const titleTop = 86;
  const descriptionTop = titleTop + titleLines.length * 64 + 30;
  const layers: OverlayOptions[] = [];

  if (options.thumbnail) {
    layers.push({ input: options.thumbnail, left: 675, top: 52 });
    layers.push({
      input: fadeOverlay(330, 520),
      raw: { width: 330, height: 520, channels: 4 },
      left: 570,
      top: 52,
    });
  }

  layers.push(
    ...titleLines.map((line, index) =>
      textLayer(line, {
        color: "#f0ebff",
        fontFile: options.semiboldFontPath,
        fontSize: 54,
        fontWeight: 600,
        height: 64,
        left: 64,
        top: titleTop + index * 64,
        width: hasThumbnail ? 650 : 1060,
      }),
    ),
    ...descriptionLines.map((line, index) =>
      textLayer(line, {
        color: "#aaa0c1",
        fontFile: options.regularFontPath,
        fontSize: 27,
        fontWeight: 400,
        height: 42,
        left: 64,
        top: descriptionTop + index * 42,
        width: hasThumbnail ? 700 : 1060,
      }),
    ),
    {
      input: {
        create: {
          width: 3,
          height: 31,
          channels: 4,
          background: "#4a3a68",
        },
      },
      left: 1128,
      top: 568,
    },
    {
      input: {
        create: {
          width: 31,
          height: 3,
          channels: 4,
          background: "#4a3a68",
        },
      },
      left: 1100,
      top: 596,
    },
  );

  return sharp({
    create: {
      width: ogImageWidth,
      height: ogImageHeight,
      channels: 4,
      background: "#09070f",
    },
  })
    .composite(layers)
    .png()
    .toBuffer();
}
