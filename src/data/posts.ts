export interface Post {
  slug: string;
  type: "Post" | "Paper";
  title: string;
  excerpt: string;
  date: string;
  tags: string[];
  content: string;
  sourceId?: string;
  /** A build-time copy of Notion's FeaturedImage or page cover. */
  featuredImage?: string;
}

export const posts: Post[] = [
  {
    slug: "why-astro",
    type: "Post",
    title: "我为什么选择 Astro",
    excerpt: "Astro GOOD GOOD GOOD!!!!!",
    date: "2026-08-29",
    tags: ["Astro"],
    content: "Astro IS JUST SO GOOOOOOD.",
  },
];
