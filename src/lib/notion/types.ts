export type UnknownRecord = Record<string, unknown>;

export interface BookmarkPreview {
  title: string;
  description: string;
  faviconUrl: string;
  hostname: string;
}

/** The small, renderer-friendly shape used by the Astro components. */
export interface NotionBlock {
  id: string;
  type: string;
  hasChildren: boolean;
  data: UnknownRecord;
  children?: NotionBlock[];
  /** A Notion-hosted file copied to /public/notion during the build. */
  assetUrl?: string;
  /** Build-time metadata for bookmark and link-preview tiles. */
  bookmarkPreview?: BookmarkPreview;
}
