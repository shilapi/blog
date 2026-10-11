export const siteConfig = {
  siteUrl: "https://lapiw.icu",
  siteName: "Shilapi's blog",
  brandName: "shilapi@blog",
  description: "Shilapi's blog, where shit posts happpen.",
  language: "zh-CN",
} as const;

export interface ServiceLink {
  label: string;
  href: string;
  description?: string;
}

// Add your external tools and projects here. The homepage renders three columns.
export const serviceLinks = [
  // {
  //   label: "~/status",
  //   href: "https://status.example.com",
  //   description: "服务状态",
  // },
  {
    label: "Surge Config Editor",
    href: "https://surgeconfig.lapiw.icu/",
    description: "Config editor for surge, a proxy tool.",
  },
] satisfies ServiceLink[];

export const projectLinks = [
  {
    label: "xcertplay",
    href: "https://github.com/shilapi/xcertplay/",
    description: "Open-source CarPlay solution for Android head units.",
  },
  {
    label: "ClipperOne",
    href: "https://github.com/KarkeNeko/ClipperOne/",
    description: "Open-source replica of Flipper Zero.",
  },
] satisfies ServiceLink[];