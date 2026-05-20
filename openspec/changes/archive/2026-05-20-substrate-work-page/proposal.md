## Why

`substratesystems.io` is the URL on Hugo Ander Kivi's CV. A recruiter or hiring manager who follows it should land on evidence that the CV's claims are real, but the site is currently a company landing page with no personal proof surface. This change adds `/work`: a single static page that consolidates Hugo's shipped work and links the proof points the CV references — chiefly the "governance framework now in production" claim, now backed by the `/blog/governance-as-compression` article.

## What Changes

- Add a static route `/work` framed as **"Hugo Ander Kivi — work"**: personal first-person body copy, with Substrate Systems as operational context (hybrid voice — clean person/company separation).
- Sections: intro/positioning; Writing (the governance article); Selected work (Endstate, Q); Links/contact.
- Contact links: GitHub (`github.com/Artexis10`) and email (`founder@substratesystems.io`) always shown. LinkedIn and a downloadable CV PDF are shown only when their assets are present (graceful gating — no broken links).
- Page copy is domain-neutral: no employer-identifying terms and no iGaming-domain vocabulary, so the public page does not leak the domain the governance article was written to avoid.
- Token-only styling under the existing Substrate brand chrome (shared header pattern + `Footer`, dark theme, Inter). No new design tokens.
- `src/app/sitemap.ts` lists `/work`.

## Capabilities

### New Capabilities

- `work-page`: Serves Hugo's consolidated proof-surface page at `/work` — positioning, the governance-article link, selected shipped work (Endstate, Q), and contact/credential links with availability-gated CV and LinkedIn entries.

### Modified Capabilities

<!-- None — no existing specs affected. -->

## Impact

- New route files: `src/app/work/page.tsx`, `src/app/work/layout.tsx`.
- Modified: `src/app/sitemap.ts` (adds `/work`).
- No new dependencies, no database/auth/env changes, no `next.config.ts` changes.
- Owner-supplied assets (LinkedIn URL, CV PDF in `public/downloads/`) are optional and gated; the page ships and renders correctly without them.
