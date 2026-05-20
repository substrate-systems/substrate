## Context

The site is a Next.js 16 App Router project with a restrained, token-based design system (`DESIGN_SYSTEM.md`, tokens in `src/app/globals.css` + `tailwind.config.ts`). Routes are flat at the app root (`/endstate`, `/terms`, `/updates`); there is no route-group convention and no "platform-root" subtree distinction. No markdown tooling exists yet, so this change defines the convention.

## Goals

- Serve `content/blog/<slug>.md` at a stable `/blog/<slug>` URL.
- Zero runtime cost: render markdown at build time, ship static HTML.
- Stay inside the existing design system — no new tokens, no palette leak.

## Non-Goals

- Blog index page, RSS, tag/category/search pages, OG image generation, comments. Deferred.
- A CMS or any non-repo content source.

## Decisions

- **Build-time static, not MDX, not runtime.** Content stays portable `.md` outside the module graph, read via `fs` from `content/blog/`. `generateStaticParams` enumerates slugs and `dynamicParams = false` makes unknown slugs 404. This avoids `@next/mdx` config changes and any per-request parsing, maximizing Lighthouse.
- **`unified` pipeline.** `remark-parse` → `remark-gfm` → `remark-rehype` → `rehype-slug` → `rehype-autolink-headings` → `rehype-pretty-code` (shiki) → `rehype-react`. Gives GFM tables, heading anchors, and syntax highlighting in one chain. The terminal step renders a React element tree rather than an HTML string, so the page never injects raw markup.
- **Token-only styling.** Prose styles live in a colocated CSS module referencing existing CSS custom properties (`--fg-primary`, `--fg-secondary`, `--border-subtle`, etc.). Dark theme + Inter inherited from root layout. Reuse `src/components/Footer.tsx`; minimal brand-wordmark header.
- **Frozen permalink.** `/blog/<slug>` where `slug` equals the markdown filename. The CV links here; the URL must not change after ship.

## Risks / Trade-offs

- **Markdown rendering safety.** The pipeline renders to a React element tree (`rehype-react`); the page renders React nodes, never an injected HTML string, so React escapes text by construction. Raw-HTML passthrough is also disabled (no `allowDangerousHtml`), so HTML embedded in a markdown source is dropped rather than rendered. Content is first-party (committed, PR-reviewed). **If the content source ever becomes untrusted, add `rehype-sanitize` with a shiki-aware schema before that source ships.**
- **Dependency surface.** Ten small build-time packages. Accepted: they are the standard, well-maintained remark/rehype ecosystem and run only at build.

## Migration Plan

Additive. New files plus a sitemap edit and dependency additions. No data migration, no breaking change to existing routes.

## Open Questions

None — visual style (design-token monochrome) and header (brand wordmark → home) confirmed with the owner.
