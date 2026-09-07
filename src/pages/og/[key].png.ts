import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { APIRoute, GetStaticPaths } from "astro";
import { siteConfig } from "../../config";
import { getPosts } from "../../lib/notion";
import {
  ogImageHeight,
  ogImageKey,
  ogImageWidth,
  renderOgImage,
  type OgImageData,
} from "../../lib/og";

interface Props {
  image: OgImageData;
}

export const getStaticPaths: GetStaticPaths = async () => {
  const posts = await getPosts();
  return [
    {
      params: { key: "site" },
      props: {
        image: {
          title: siteConfig.brandName,
          description: siteConfig.description,
        },
      } satisfies Props,
    },
    {
      params: { key: "posts" },
      props: {
        image: {
          title: "~/posts",
          description: "All posts.",
        },
      } satisfies Props,
    },
    ...posts.map((post) => ({
      params: { key: ogImageKey(post) },
      props: {
        image: {
          title: post.type === "Post" ? post.title : `~/${post.title}`,
          description: post.excerpt || siteConfig.description,
          thumbnail: post.featuredImage,
        },
      } satisfies Props,
    })),
  ];
};

async function thumbnailData(source?: string): Promise<Buffer | undefined> {
  if (!source?.startsWith("/")) return undefined;
  const sourcePath = path.join(process.cwd(), "public", source);
  if (!existsSync(sourcePath)) return undefined;

  return readFile(sourcePath);
}

export const GET: APIRoute<Props> = async ({ props }) => {
  const fontDirectory = path.join(process.cwd(), "public", "fonts");
  const regularFontPath = path.join(fontDirectory, "Pretendard-Regular.woff2");
  const semiboldFontPath = path.join(
    fontDirectory,
    "Pretendard-SemiBold.woff2",
  );
  const png = await renderOgImage(props.image, {
    regularFontPath,
    semiboldFontPath,
    thumbnail: await thumbnailData(props.image.thumbnail),
  });

  return new Response(new Uint8Array(png), {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      "X-Image-Height": String(ogImageHeight),
      "X-Image-Width": String(ogImageWidth),
    },
  });
};
