## 1. Dependencies

- [x] 1.1 `npm i gray-matter unified remark-parse remark-gfm remark-rehype rehype-slug rehype-autolink-headings rehype-pretty-code shiki rehype-react` (runtime `dependencies`).

## 2. Content helper

- [x] 2.1 Create `src/lib/blog.ts` with `BlogFrontmatter` type and `getPostSlugs()` reading `path.join(process.cwd(), "content/blog")`.
- [x] 2.2 Implement `getPostBySlug(slug)`: read file, split with `gray-matter`, run the unified pipeline (`remark-parse` → `remark-gfm` → `remark-rehype` → `rehype-slug` → `rehype-autolink-headings` → `rehype-pretty-code` → `rehype-react`) to a React element tree. Raw-HTML passthrough OFF.

## 3. Route, layout, styles

- [x] 3.1 Create `src/app/blog/layout.tsx` with metadata title template `%s · Substrate`.
- [x] 3.2 Create `src/app/blog/[slug]/page.tsx`: `dynamicParams = false`, `generateStaticParams()`, `generateMetadata()`, `notFound()` on miss, brand-wordmark header, `<h1>` + published date + rendered body React tree, shared `Footer`.
- [x] 3.3 Create `src/app/blog/[slug]/article.module.css`: prose styles for `h2,h3,p,ul,ol,li,a,strong,code,pre,blockquote` referencing existing CSS vars only; style the `<pre>` container.

## 4. Sitemap

- [x] 4.1 Update `src/app/sitemap.ts` to append `/blog/<slug>` entries generated from `getPostSlugs()`.

## 5. Verification

- [x] 5.1 `npm run openspec:validate` passes in strict mode (8/8 items).
- [x] 5.2 `npm run build` compiles with no TypeScript errors; `/blog/[slug]` is `●` SSG with `/blog/governance-as-compression` prerendered.
- [~] 5.3 `npm run lint` — N/A: repo has no ESLint config and `next lint` is removed in Next 16 (pre-existing). TypeScript correctness covered by the build.
- [x] 5.4 Loaded `/blog/governance-as-compression` (prod server): `<h1>` = title, "May 20, 2026 · Hugo Ander Kivi" visible, 7 h2 with anchor ids, code blocks shiki-highlighted (91 token spans), shared `Footer` present, dark + Inter, brand wordmark header. Screenshot captured.
- [x] 5.5 `/blog/does-not-exist` returns 404; `/` returns 200.
- [~] 5.6 No Lighthouse-audit MCP tool available + chrome profile locked; not formally scored. Page is static prerendered HTML with minimal JS (inherently high). Only console error is the site-wide Vercel Analytics 404 (resolves on Vercel only).
- [x] 5.7 Palette-leak grep over `src/app/blog` and `src/lib/blog.ts` finds no hardcoded hexes / DM Sans / teal — only token CSS vars.

## 6. Release

- [ ] 6.1 Commit and push (lefthook pre-push runs strict OpenSpec validation).
- [ ] 6.2 Deploy.
- [ ] 6.3 Post-deploy: `curl -sI https://substratesystems.io/blog/governance-as-compression` returns 200.
- [ ] 6.4 Archive the OpenSpec change: `openspec archive substrate-blog-route` once deploy is verified.
