"use client";

import { useMemo, type ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeReact from "rehype-react";
import { toString } from "mdast-util-to-string";
import type { Root } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm);

/** The note's own heading and first prose paragraph supply its reader and preview. */
export function describeNote(body: string) {
  const tree = parser.parse(body) as Root;
  const heading = tree.children.find((node) => node.type === "heading" && node.depth === 1);
  const paragraph = tree.children.find((node) => node.type === "paragraph");
  return {
    heading: heading ? toString(heading, { includeHtml: false }) : null,
    summary: paragraph ? toString(paragraph, { includeHtml: false }) : null,
  };
}

/** Parsed Markdown becomes React elements. Raw HTML and remote image requests stay disabled. */
export function NoteMarkdown({
  body,
  title,
  onRead,
}: {
  body: string;
  title: string;
  onRead: (ref: string) => void;
}) {
  return useMemo(() => {
    function Link({ href, children }: { href?: string; children?: ReactNode }) {
      if (!href) return <span>{children}</span>;
      let address: URL;
      try {
        address = new URL(href);
      } catch {
        return <span>{children}</span>;
      }
      if (address.protocol === "exomem:" && address.hostname === "memory")
        return (
          <button type="button" onClick={() => onRead(href)}>
            {children}
          </button>
        );
      // Only these URL protocols are navigable; note content cannot select executable schemes.
      if (!["https:", "http:", "mailto:"].includes(address.protocol))
        return <span>{children}</span>;
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
          {children}
        </a>
      );
    }
    function Image({ alt }: { alt?: string }) {
      return alt ? <span>{alt}</span> : null;
    }
    const tree = parser.parse(body) as Root;
    const first = tree.children[0];
    if (first?.type === "heading" && first.depth === 1 && toString(first).trim() === title.trim())
      tree.children.shift();
    const renderer = unified()
      .use(remarkRehype)
      .use(rehypeReact, { Fragment, jsx, jsxs, components: { a: Link, img: Image } });
    return renderer.stringify(renderer.runSync(tree)) as ReactNode;
  }, [body, title, onRead]);
}
