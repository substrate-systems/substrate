import type { ReactNode } from "react";

/**
 * Exomem FAQ. `a` is the rich answer rendered on the page; `aText` is a plain-text
 * twin used only for the FAQPage JSON-LD (schema.org requires plain text). Provide
 * `aText` whenever `a` contains JSX. Answers must stay consistent with
 * `public/llms-full.txt` and the exomem repo (README + docs/benchmarks.md).
 */
export type Faq = { q: string; a: ReactNode; aText?: string };

const linkClass =
  "text-fg-primary underline decoration-border-emphasis underline-offset-4 transition-opacity duration-default hover:opacity-70";

export const faqs: Faq[] = [
  {
    q: "Which agents and clients work with Exomem?",
    a: "Any MCP-capable client — Claude Code, Claude Desktop, Codex, Cursor, or a custom agent. You can also reach the same memory from a CLI (kb / exomem) or a personal REST facade, all generated from the same operation registry.",
  },
  {
    q: "Do my notes ever leave my machine?",
    a: "No. Your vault stays as plain Markdown files you own, and the search indexes are local SQLite sidecar files next to it. The lean install has no cloud dependency — nothing is uploaded.",
  },
  {
    q: "Do I need a GPU?",
    a: "No. The lean install runs keyword and BM25 search out of the box, because SQLite's FTS5 engine ships inside Python's standard library. Optional extras add local embeddings, CLIP image search, OCR, and speech-to-text — a GPU accelerates those but is never required.",
  },
  {
    q: "How fast is search on a large vault?",
    a: (
      <>
        Measured on a 50,000-note corpus: sub-second hybrid search end-to-end — 864 ms
        on the reference desktop, hot cache off — with the keyword and lexical lanes
        answering in milliseconds from the FTS5 index. The full methodology is published
        in{" "}
        <a
          href="https://github.com/Artexis10/exomem/blob/main/docs/benchmarks.md"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          docs/benchmarks.md
        </a>
        .
      </>
    ),
    aText:
      "Measured on a 50,000-note corpus: sub-second hybrid search end-to-end — 864 ms on the reference desktop, hot cache off — with the keyword and lexical lanes answering in milliseconds from the FTS5 index. The full benchmark methodology is published in the repository at docs/benchmarks.md.",
  },
  {
    q: "How is Exomem different from cloud memory services?",
    a: "Cloud memory tools extract your data into a vector database or knowledge graph that lives in their cloud. Exomem keeps your memory as plain Markdown in a vault you own and indexes it locally — your files are the memory, not a derived copy in someone else's store.",
  },
  {
    q: "What's the difference between the lean and full install?",
    a: "The lean install is keyword and BM25 search over your vault with zero extra dependencies. The full install adds local embeddings and CLIP image search (--extra embeddings) plus OCR, PDF and Office extraction, and audio/video transcription (--extra media) — so screenshots, scans, and recordings become searchable, all locally.",
  },
  {
    q: "Is Exomem open source?",
    a: (
      <>
        Yes — Exomem is licensed AGPL-3.0 and the source is on{" "}
        <a
          href="https://github.com/Artexis10/exomem"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          GitHub
        </a>
        . You self-host it; there is no paid tier and no account required.
      </>
    ),
    aText:
      "Yes — Exomem is licensed AGPL-3.0 and the source is on GitHub. You self-host it; there is no paid tier and no account required.",
  },
  {
    q: "How do I install it?",
    a: (
      <>
        Run <code className="font-mono text-fg-primary">pip install exomem</code>, then
        point it at your existing Obsidian or Markdown vault. See the{" "}
        <a
          href="https://github.com/Artexis10/exomem/blob/main/README.md"
          target="_blank"
          rel="noopener noreferrer"
          className={linkClass}
        >
          README
        </a>{" "}
        for setup and MCP client configuration.
      </>
    ),
    aText:
      "Run pip install exomem, then point it at your existing Obsidian or Markdown vault. See the README for setup and MCP client configuration.",
  },
];
