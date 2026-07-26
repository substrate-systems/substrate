import type { ReactElement } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeReact from "rehype-react";

const BLOG_DIR = path.join(process.cwd(), "content/blog");

export type BlogFrontmatter = {
  title: string;
  slug: string;
  description: string;
  published: string;
  updated?: string;
  tags: string[];
  author: string;
  /** "draft" posts stay reachable by URL but are noindex + excluded from listings/sitemap. */
  status: string;
};

const BLOG_REDIRECTS = {
  "set-up-new-windows-pc-fast": "/blog/new-windows-pc-setup-guide",
} as const;

export function getBlogRedirect(slug: string): string | undefined {
  return BLOG_REDIRECTS[slug as keyof typeof BLOG_REDIRECTS];
}

export type BlogPost = {
  frontmatter: BlogFrontmatter;
  content: ReactElement;
};

function normalizeFrontmatter(data: Record<string, unknown>): BlogFrontmatter {
  const normalizeDate = (value: unknown) =>
    value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "");

  return {
    title: String(data.title ?? ""),
    slug: String(data.slug ?? ""),
    description: String(data.description ?? ""),
    published: normalizeDate(data.published),
    ...(data.updated ? { updated: normalizeDate(data.updated) } : {}),
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    author: String(data.author ?? ""),
    status: String(data.status ?? ""),
  };
}

export function isDraft(frontmatter: BlogFrontmatter): boolean {
  return frontmatter.status.toLowerCase() === "draft";
}

export function getPostSlugs(): string[] {
  return readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/, ""));
}

export function getAllPostsMeta(): BlogFrontmatter[] {
  return getPostSlugs().map((slug) => {
    const raw = readFileSync(path.join(BLOG_DIR, `${slug}.md`), "utf8");
    // Filename wins over a frontmatter `slug`. Routing is filename-based
    // (getPostSlugs feeds generateStaticParams), so letting the two disagree
    // would emit listing/sitemap URLs that 404 under dynamicParams = false.
    return { ...normalizeFrontmatter(matter(raw).data), slug };
  });
}

/** Non-draft posts only — for public listings (blog index) and the sitemap. */
export function getPublishedPostsMeta(): BlogFrontmatter[] {
  return getAllPostsMeta().filter((post) => !isDraft(post) && !getBlogRedirect(post.slug));
}

export async function getPostBySlug(slug: string): Promise<BlogPost | null> {
  let raw: string;
  try {
    raw = readFileSync(path.join(BLOG_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }

  const { data, content } = matter(raw);

  // Rendered to a React element tree (not an HTML string): React escapes text and
  // no raw markup is injected. Raw-HTML passthrough is also OFF — remarkRehype runs
  // without allowDangerousHtml, so HTML embedded in a markdown source is dropped.
  // content/blog is first-party only. See openspec change substrate-blog-route.
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: "wrap" })
    .use(rehypePrettyCode, { theme: "github-dark", keepBackground: false })
    .use(rehypeReact, { Fragment, jsx, jsxs })
    .process(content);

  return { frontmatter: normalizeFrontmatter(data), content: file.result as ReactElement };
}
