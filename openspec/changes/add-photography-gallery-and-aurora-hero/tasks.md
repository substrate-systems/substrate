## 1. Curate and Prepare Assets

- [x] 1.1 Review the 51 Iceland exports at full-size where needed and select a 12–18 image sequence following the approved colour → abstraction → black-and-white crescendo → `02136` close.
- [x] 1.2 Confirm each selected file is the intended edit and reject near-duplicate treatments unless a deliberate pairing is documented.
- [x] 1.3 Create non-destructive web derivatives under `public/photography/iceland-aurora/`, preserving sRGB-compatible colour and recording dimensions.
- [x] 1.4 Create the `02129-3` homepage hero derivative(s) under `public/brand/materials/` and retain the original edited JPEG outside the repo.
- [x] 1.5 Record final asset sizes and verify no unselected source export is copied into the project.
- [x] 1.6 Lock and visually review the complete manifest sequence, cover choice, any diptych declarations, introduction, and captions before route implementation begins.

## 2. Static Photography Model

- [x] 2.1 Add a typed gallery manifest with series metadata and ordered image metadata.
- [x] 2.2 Add concise, useful alt text and optional captions for every selected image.
- [x] 2.3 Add tests for manifest uniqueness, valid asset paths, explicit dimensions, and a non-empty ordered sequence.

## 3. Photography Routes

- [x] 3.1 Build the static `/photography` index with shared Substrate chrome, short personal framing, and the Iceland series entry.
- [x] 3.2 Build `/photography/iceland-aurora` as an editorial sequence with large single frames, generous spacing, and only deliberate paired frames.
- [x] 3.3 Add route metadata and include both routes in the sitemap.
- [x] 3.4 Add Photography to the global footer and `/work` “Elsewhere” links without promoting it as a product.

## 4. Full-Screen Viewer

- [x] 4.1 Implement each in-flow image opener as an accessible button and the viewer as a labelled modal dialog with close, previous, and next actions.
- [x] 4.2 Add `Escape`/arrow-key handling, focus containment/restoration, background inertness, body-scroll lock, “image N of total” announcement, screen-reader labels, horizontal touch/pointer swipe navigation, and disabled end controls (no sequence wrapping).
- [x] 4.3 Respect reduced motion and keep the underlying page sequence usable without the viewer.
- [x] 4.4 Add interaction tests for open, non-wrapping navigation boundaries, close, and focus restoration.

## 5. Homepage Hero

- [x] 5.1 Replace `metal-structure-dark.jpg` with the approved `02129-3` derivative and establish breakpoint-specific crop/object-position treatment.
- [x] 5.2 Tune overall dimming, local gradient, vignette, noise, and parallax together; the old overlay opacity is not a constraint.
- [ ] 5.3 Preserve the canonical logo and copy as foreground elements and verify WCAG AA contrast.
- [x] 5.4 Replace the decorative scroll line with a keyboard-accessible `Explore ↓` anchor targeting `#content` on the Hook section.
- [x] 5.5 Ensure the control has a 44×44 minimum target and a reduced-motion-safe cue.
- [x] 5.6 Update `DESIGN_SYSTEM.md` with the approved authored-photographic-atmosphere category and its boundary from stock/material textures and product proof.
- [x] 5.7 Replace stale root hero attribution metadata, update `ATTRIBUTIONS.md`, and remove the stock hero asset if it is unused after implementation.
- [x] 5.8 Update the default `/api/og` treatment to use the authored aurora asset and verify its 1200×630 crop/readability.
- [ ] 5.9 Replace the hero secondary line with `Owned machines. Durable memory. Source-grounded AI.` and verify its responsive wrapping does not crowd the hero hierarchy or `Explore ↓`.

## 6. Homepage Narrative and Motion

- [ ] 6.1 Rewrite the Hook section with the approved control-and-continuity thesis.
- [ ] 6.2 Replace the abstract Philosophy axioms with the approved setup/memory/sources sequence in normal document flow.
- [ ] 6.3 Implement the monochrome structural-spine progression and statement activation with a complete static reduced-motion state.
- [ ] 6.4 Update Q, Endstate, and Exomem descriptions with the approved product-first copy while retaining the flagship-first order.
- [ ] 6.5 Add focused tests for approved copy, ordered statements, normal-flow semantics, and reduced-motion-safe final state.

## 7. Verification

- [x] 7.1 Run manifest/component tests and the existing relevant test suite.
- [ ] 7.2 Run `npm run openspec:validate` and `npm run build`.
- [ ] 7.3 Capture 1440×900 desktop and 390×844 portrait-mobile screenshots for the hero, homepage narrative/products, index, series, and viewer, plus an additional tablet hero crop check.
- [ ] 7.4 Verify keyboard-only and reduced-motion behaviour.
- [ ] 7.5 Inspect network requests at the named desktop/mobile viewports, record requested derivative dimensions/transferred bytes, confirm only the first in-flow series image is eager, and confirm the viewer preloads at most current plus adjacent images rather than the full series.
- [ ] 7.6 Run an independent reviewer/verifier pass against this proposal and the rendered surfaces.

## 8. Hand-off

- [ ] 8.1 Report the final image sequence, derivative paths/sizes, screenshots, tests, and known trade-offs.
- [ ] 8.2 Leave commit, push, deployment, and OpenSpec archive to Hugo unless separately requested.
