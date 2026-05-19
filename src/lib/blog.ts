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
  tags: string[];
  author: string;
};

export type BlogPost = {
  frontmatter: BlogFrontmatter;
  content: ReactElement;
};

function normalizeFrontmatter(data: Record<string, unknown>): BlogFrontmatter {
  const published =
    data.published instanceof Date
      ? data.published.toISOString().slice(0, 10)
      : String(data.published ?? "");

  return {
    title: String(data.title ?? ""),
    slug: String(data.slug ?? ""),
    description: String(data.description ?? ""),
    published,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    author: String(data.author ?? ""),
  };
}

export function getPostSlugs(): string[] {
  return readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.replace(/\.md$/, ""));
}

export function getAllPostsMeta(): BlogFrontmatter[] {
  return getPostSlugs().map((slug) => {
    const raw = readFileSync(path.join(BLOG_DIR, `${slug}.md`), "utf8");
    return normalizeFrontmatter(matter(raw).data);
  });
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
