## Context

`/work` is item #2 of the proof-surface buildout; it depends on the governance article (item #1), which shipped in change `substrate-blog-route`. The site is a Next.js 16 App Router project with flat root routes (`/endstate`, `/terms`, `/blog`) and a token-based design system. `/work` follows the same conventions established by `/blog`.

## Goals

- Give the CV URL a destination that reinforces the CV's senior-IC claims with click-through evidence.
- Keep person and company cleanly separated so the page reads as Hugo's proof surface, not Substrate marketing.
- Ship without broken links even before optional assets (CV, LinkedIn) exist.

## Non-Goals

- A homepage nav link to `/work` (kept separate per the hybrid framing; revisit later).
- A standalone Hub88/employer writeup, blog index, RSS, OG-image generation, or contact form.

## Decisions

- **Hybrid voice.** Header reads "Hugo Ander Kivi — work"; body is first-person; Substrate is context. Avoids the "is this the person or the company?" ambiguity a purely personal or purely company voice would create on a company-branded domain.
- **Three surfaces.** Governance article (headline proof), Endstate, Q. The production-governance claim is carried by the article link plus a broad intro reference — no standalone employer section.
- **Graceful gating.** CV-download link renders only if `public/downloads/hugo-ander-kivi-cv.pdf` exists (build-time `fs` check); LinkedIn link renders only if a configured `LINKEDIN_URL` constant is non-empty. GitHub + email always render.
- **Static server component, token-only styling.** Mirrors `Products.tsx` / `Footer.tsx` / the `/blog` header. No client-side motion; the page is fully static (SSG).

## Risks / Trade-offs

- **Domain leakage.** The CV's "hundreds of millions of daily bets" phrasing would expose the iGaming domain on a public, indexable page — contradicting the article's redaction discipline. Mitigation: domain-neutral scale language only ("hundreds of millions of operations a day"), enforced by a redaction grep in verification and owner review of the intro wording before deploy.
- **Optional assets absent at first.** Acceptable: gating means the page is correct with or without them; links appear once assets land.

## Migration Plan

Additive. New route files plus a sitemap edit. No data migration, no change to existing routes.

## Open Questions

- Final intro wording (scale phrasing) to be confirmed by owner at verification.
- LinkedIn URL and CV PDF to be supplied by owner; both gate gracefully until then.
