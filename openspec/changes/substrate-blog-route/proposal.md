## Why

The long-form article `content/blog/governance-as-compression.md` exists in the repo, but the site has no route that serves it — `substratesystems.io/blog/governance-as-compression` currently 404s. This article is the external proof point linked from Hugo's CV, so it needs a public, permanently stable URL. This change adds the minimum route to render markdown articles from `content/blog/<slug>.md`, establishing the blog content convention for the site. It is the first of two related changes; a later `/work` page links to this article and depends on it being live.

## What Changes

- Add a dynamic route `/blog/[slug]` that renders the markdown file `content/blog/<slug>.md` to HTML at build time.
- Add `src/lib/blog.ts`: reads `content/blog/` from disk, parses YAML frontmatter with `gray-matter`, and converts markdown to HTML via a `unified` remark→rehype pipeline (GFM, heading slugs + anchor links, shiki syntax highlighting).
- Pages are statically generated (`generateStaticParams` + `dynamicParams = false`); unknown slugs return 404. No runtime markdown parsing.
- Markdown body styling uses the existing design-system tokens only (no new tokens, no hardcoded palette). Dark theme and Inter are inherited from the root layout. The shared `Footer` is reused; a minimal brand-wordmark header links to `/`.
- Per-post SEO via `generateMetadata` (title, description, OpenGraph `article`); `src/app/sitemap.ts` lists blog posts.
- New build-time dependencies: `gray-matter`, `unified`, `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-slug`, `rehype-autolink-headings`, `rehype-pretty-code`, `shiki`, `rehype-react`.
- The pipeline renders to a React element tree (via `rehype-react`), not an injected HTML string. Raw-HTML passthrough is disabled; content is first-party only.

## Capabilities

### New Capabilities

- `blog-route`: Serves first-party markdown articles from `content/blog/<slug>.md` at the stable public path `/blog/<slug>`, statically generated, with frontmatter-driven metadata, syntax-highlighted code blocks, and heading anchors.

### Modified Capabilities

<!-- None — no existing specs affected. -->

## Impact

- New route files: `src/app/blog/[slug]/page.tsx`, `src/app/blog/[slug]/article.module.css`, `src/app/blog/layout.tsx`.
- New helper: `src/lib/blog.ts`.
- Modified: `src/app/sitemap.ts` (adds blog entries), `package.json` / `package-lock.json` (new dependencies).
- Content read at build time from `content/blog/`; no database, auth, or environment-variable changes.
- No changes to `next.config.ts`.
