import type { Post } from "../data/posts";
import { getPosts } from "./notion";

export function postHref(post: Pick<Post, "slug" | "type">): string {
  return post.type === "Paper" ? `/${post.slug}/` : `/posts/${post.slug}/`;
}

export async function getPostsByType(type: Post["type"]): Promise<Post[]> {
  return (await getPosts()).filter((post) => post.type === type);
}

export async function getArticleStaticPaths(type: Post["type"]) {
  return (await getPostsByType(type)).map((post) => ({
    params: { slug: post.slug },
    props: { post },
  }));
}

export async function getPostTagStaticPaths() {
  const posts = await getPostsByType("Post");
  const tags = [...new Set(posts.flatMap((post) => post.tags))].sort((a, b) =>
    a.localeCompare(b),
  );

  return tags.map((tag) => ({
    params: { tag },
    props: { posts: posts.filter((post) => post.tags.includes(tag)) },
  }));
}
