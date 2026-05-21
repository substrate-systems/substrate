## 1. Footer navigation

- [ ] 1.1 Edit `src/components/Footer.tsx`: add a nav row with internal `Link`s to `/work` (Work), `/blog` (Writing), `/endstate` (Endstate); wrap the wordmark in a `Link` to `/`. Token-only styling.

## 2. Blog index

- [ ] 2.1 Create `src/app/blog/page.tsx` (static): brand-wordmark header → `/`; "Writing" label; list of posts from `getAllPostsMeta()` sorted by `published` desc — each title (link to `/blog/<slug>`), dek, date; shared `Footer`. Set page metadata (title "Writing").

## 3. Sitemap

- [ ] 3.1 Update `src/app/sitemap.ts` to add `/blog`.

## 4. Verification (local-first)

- [ ] 4.1 `npm run openspec:validate` strict passes.
- [ ] 4.2 `npm run build` — `/blog` statically prerendered; no TS errors.
- [ ] 4.3 `next start` on a free port; chrome-devtools: homepage footer has `/work`,`/blog`,`/endstate` links; `/blog` lists the article (title, dek, date) linking to the article; article page footer has the nav; wordmark links `/`.
- [ ] 4.4 `curl` `/blog` → 200.
- [ ] 4.5 Palette-leak grep over new/edited files → token vars only.

## 5. Release

- [ ] 5.1 Commit and push (auto-deploys via Vercel git integration).
- [ ] 5.2 Verify live: `/blog` 200, homepage footer nav present.
- [ ] 5.3 Archive `substrate-site-navigation` after deploy verified.
