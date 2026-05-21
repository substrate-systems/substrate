## Why

The site's surfaces are disconnected. A visitor landing on `substratesystems.io` has no path to `/work` or `/blog` — the homepage links only to `/endstate` and `useq.ai`, and the global `Footer` has no navigation. The governance article is reachable only from `/work`, which is itself reachable only via the CV link. The proof surfaces only ship value if they are navigable as one system; right now they are orphaned routes tied together only by `sitemap.xml`.

## What Changes

- Add a navigation row to the global `Footer` (`src/components/Footer.tsx`): **Work** (`/work`), **Writing** (`/blog`), **Endstate** (`/endstate`). The footer renders on the homepage, `/work`, and blog articles, so this single change connects the whole graph and gives articles a way back into the site.
- Link the footer wordmark to `/` (home edge).
- Add a minimal `/blog` index (`src/app/blog/page.tsx`) listing posts — title, one-line dek, date, link — sorted newest first, so "Writing" is a real destination and articles are not dead-ends. Intentionally minimal (a list); revisit styling past ~5 posts.
- `src/app/sitemap.ts` lists `/blog`.

## Capabilities

### New Capabilities

- `site-navigation`: Global footer navigation connecting the homepage, `/work`, `/blog`, and `/endstate`, plus a `/blog` index that lists published articles.

### Modified Capabilities

<!-- None — extends navigation only; existing route specs (blog-route, work-page) are unchanged. -->

## Impact

- Modified: `src/components/Footer.tsx` (nav row + home link), `src/app/sitemap.ts` (adds `/blog`).
- New: `src/app/blog/page.tsx` (index).
- No new dependencies, no DB/auth/env/config changes. Reuses `getAllPostsMeta()` from `src/lib/blog.ts`.
