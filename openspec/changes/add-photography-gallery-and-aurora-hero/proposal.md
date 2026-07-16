## Why

Substrate's public identity is deliberately restrained, but its current homepage hero relies on borrowed architectural photography. Hugo's edited Iceland aurora photographs provide a stronger, authored visual language that already works on his LinkedIn profile and connects the taste behind Substrate to the person building it.

The site also has no quiet home for Hugo's photography. The work is not a new product or a commercial portfolio; it is a personal creative practice and a visible source of the visual judgment that carries across Substrate's products. The first finished body of work is the Iceland aurora series, with future galleries added only as similarly curated batches are completed.

The homepage's current one-pixel scroll indicator is also not discoverable. Direct user feedback from Olivia was that it was not obvious the page continued below the full-screen hero.

## What Changes

- Add a static `/photography` index with a short personal introduction and one series entry at launch.
- Add `/photography/iceland-aurora`, an editorially sequenced gallery mixing colour and black-and-white photographs from Iceland in March 2026.
- Add an accessible full-screen image viewer with keyboard, pointer, touch, and close controls.
- Add quiet Photography links to the global footer and the `/work` page's “Elsewhere” section.
- Replace the homepage's stock `metal-structure-dark.jpg` hero with `20260323_012442_A7RV_02129-3.jpg`, using responsive art direction and an image-specific contrast overlay.
- Keep the hero's primary positioning line, replace its generic secondary line with the product thesis `Owned machines. Durable memory. Source-grounded AI.`, and rewrite the below-fold homepage narrative around control, continuity, and source-grounded systems.
- Replace the current abstract axiom sequence with a restrained scroll-led motion system in which the aurora's visual energy resolves into a monochrome structural spine connecting three concrete product principles.
- Port the approved Fable/Claude Design handoff at high fidelity: dissolve the hero into a faint mirrored afterglow, resolve three organic spine strands into one straight system line at the reader's position, map the three principles directly into the Q/Endstate/Exomem product index, and close with `Systems precede products.`
- Use the authored aurora treatment in the default Substrate OG image, remove stale third-party hero attribution metadata, and document the new authored-photography category in the design system.
- Replace the ambiguous decorative scroll line with a clickable `Explore ↓` control that moves to the first content section.

## Capabilities

### New Capabilities

- `photography-gallery`: static series index, curated series pages, responsive images, and accessible full-screen viewing.

### Modified Capabilities

- `homepage-hero`: authored aurora background, responsive crop/overlay treatment, and explicit scroll affordance.
- `site-navigation`: quiet links to the photography index from the footer and personal work page.

## Non-Goals

- A CMS, upload interface, Lightroom sync, database, chronological photo feed, or automatic archive ingestion.
- Publishing every strong photograph Hugo has taken. Only completed, deliberately sequenced series ship.
- Selling prints, licensing images, collecting leads, comments, likes, or analytics specific to individual photographs.
- Reusing the aurora imagery indiscriminately across Q, Endstate, or Exomem product-proof surfaces.
- Reworking product-specific page identities, product functionality, or the quiet B2B surfaces elsewhere on the site.

## Impact

- New static routes under `src/app/photography/`.
- New gallery components and a small typed static series manifest.
- Curated web exports under `public/photography/iceland-aurora/` and one hero asset under `public/brand/materials/`.
- Updates to `src/components/Hero.tsx`, `src/components/Hook.tsx`, `src/components/Philosophy.tsx`, `src/components/Products.tsx`, `src/components/Footer.tsx`, and `src/app/work/page.tsx`.
- New focused homepage composition components for the afterglow, scroll reveal manager, closing axiom, and converging signature spine.
- Updates to root metadata, `ATTRIBUTIONS.md`, `DESIGN_SYSTEM.md`, and the default OG renderer so hero authorship remains accurate across public surfaces.
- Updates to sitemap and route metadata.
- No database, API, authentication, dependency, or environment-variable changes.
