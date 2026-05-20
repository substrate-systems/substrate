## 1. Route and layout

- [x] 1.1 Create `src/app/work/layout.tsx`: metadata (title `Work · Hugo Ander Kivi`, description, OpenGraph).
- [x] 1.2 Create `src/app/work/page.tsx` (server component, static): brand-wordmark header → `/`; intro/positioning (hybrid voice, domain-neutral scale); Writing section linking `/blog/governance-as-compression`; Selected work (Endstate `/endstate` + `github.com/Artexis10/endstate`, Q `useq.ai`); Links (GitHub + email always; LinkedIn + CV gated); shared `Footer`.
- [x] 1.3 Gating: build-time `fs` check for `public/downloads/hugo-ander-kivi-cv.pdf`; `LINKEDIN_URL` constant (empty by default).

## 2. Sitemap

- [x] 2.1 Update `src/app/sitemap.ts` to add `/work` (priority 0.8, monthly).

## 3. Verification (local-first)

- [x] 3.1 `npm run openspec:validate` passes strict (9/9).
- [x] 3.2 `npm run build` — `/work` is `○` statically prerendered, no TS errors.
- [x] 3.3 `next start` on :3100; chrome-devtools MCP loaded `/work`, full-page screenshot confirms render + links + domain-neutral copy. Console clean apart from site-wide Vercel Analytics 404 (local-only) + benign CSS-preload warning.
- [x] 3.4 `curl` `/work` → 200.
- [x] 3.5 Palette-leak grep over `src/app/work` → clean (token vars only).
- [x] 3.6 Redaction grep over `src/app/work` → clean (no Hub88/Yolo/bet/betting/iGaming/gambling).

## 4. Release

- [ ] 4.1 Commit and push (lefthook strict OpenSpec gate).
- [ ] 4.2 Deploy (owner-gated); `curl -sI https://substratesystems.io/work` → 200.
- [ ] 4.3 Archive `substrate-work-page` after deploy (and after `substrate-blog-route` is archived).

## 5. Owner-supplied assets (optional, gated)

- [ ] 5.1 Set `LINKEDIN_URL` once provided.
- [ ] 5.2 Drop `hugo-ander-kivi-cv.pdf` into `public/downloads/`.
