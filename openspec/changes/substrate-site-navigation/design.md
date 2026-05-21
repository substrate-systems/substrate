## Context

Three public surfaces shipped (`/`, `/work`, `/blog/<slug>`) but they form a disconnected graph: the only human-navigable edge into the proof surfaces is the direct CV link to `/work`. The Substrate thesis is that systems compound when integrated; orphaned routes contradict it. This change adds the navigation backbone.

## Goals

- Make every surface reachable from every other surface via persistent, on-brand navigation.
- Give "Writing" a real hub (`/blog` index) instead of a single deep link.
- Keep the homepage's editorial hero flow undisturbed.

## Non-Goals

- A homepage "Writing" section (louder, more personal — explicitly deferred by owner).
- A top header nav bar (the site is intentionally hero-driven; footer nav is enough).
- Rich blog-index styling, tags, pagination — minimal list until posts exceed ~5.

## Decisions

- **Footer as the backbone.** The `Footer` already renders on `/`, `/work`, and articles, so adding nav there connects the whole graph with one component edit and no per-page work. This satisfies "articles link back into the graph" automatically.
- **Flat link to `/blog`, no dropdown.** The index does the routing; a dropdown of articles is premature at one post.
- **Minimal index.** Title (link), dek (frontmatter `description`), date, sorted newest-first via `getAllPostsMeta()`. Token-only styling, mirrors the article header/footer chrome.
- **Hybrid framing preserved.** A subtle footer link integrates `/work` without making the company homepage "about Hugo" — no personal content is pushed into the hero.

## Risks / Trade-offs

- Footer nav appears on every page including `/endstate`; the links are generic site navigation, so this is fine. No risk to the redaction posture (no new copy with domain terms).

## Migration Plan

Additive. One component edit, one new route, one sitemap line. No data migration, no breaking changes.

## Open Questions

None — placement (footer), scope (Work/Writing/Endstate, flat `/blog`), and index minimalism confirmed with owner.
