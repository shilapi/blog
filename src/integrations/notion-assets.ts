import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

async function copyDirectory(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });

  await Promise.all(
    entries.map((entry) => {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      return entry.isDirectory()
        ? copyDirectory(sourcePath, destinationPath)
        : copyFile(sourcePath, destinationPath);
    }),
  );
}

/**
 * Astro copies `public/` before page rendering. Notion media is downloaded
 * while pages render, so copy it into the final output after the build too.
 * This directory is generated only; resetting it prevents filenames left by
 * old builds from being copied into the current deployment.
 */
export default function notionAssets(): AstroIntegration {
  return {
    name: "notion-assets",
    hooks: {
      "astro:build:start": async () => {
        await rm(path.join(process.cwd(), "public", "notion"), {
          recursive: true,
          force: true,
        });
      },
      "astro:build:done": async ({ dir }) => {
        const source = path.join(process.cwd(), "public", "notion");
        if (!existsSync(source)) return;

        const output = path.join(fileURLToPath(dir), "notion");
        await copyDirectory(source, output);
      },
    },
  };
}
