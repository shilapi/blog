// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import notionAssets from "./src/integrations/notion-assets";

// https://astro.build/config
export default defineConfig({
  site: process.env.SITE_URL ?? "https://lapiw.icu",
  integrations: [notionAssets(), sitemap()],
});
