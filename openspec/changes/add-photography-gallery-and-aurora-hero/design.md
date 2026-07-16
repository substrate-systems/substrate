## Context

Substrate currently presents a mature monochrome identity: near-black surfaces, a white wordmark, light Inter typography, restrained physical motion, and a full-viewport hero backed by stock architectural photography. Hugo's black-and-white Iceland aurora motion studies preserve the monochrome restraint while adding authorship, emotion, and a recognisable personal signature.

The approved product framing is not “Substrate launches a photography product.” Photography is a quiet personal surface explaining where the visual judgment behind the company comes from. The initial gallery is a single finished series. Future galleries arrive only as curated batches, not as a feed of newly edited files.

The homepage hero and gallery are connected but remain separate concerns: the hero uses one image as an atmospheric brand plate; the gallery shows the photographs as the work itself.

## Goals / Non-Goals

**Goals:**

- Give the Iceland aurora series an image-first, editorial presentation worthy of the work.
- Keep the route and content model simple enough that a future series is one folder plus one manifest entry.
- Mix colour and black-and-white work in a deliberate narrative sequence rather than splitting by treatment.
- Replace the stock homepage hero with Hugo's `02129-3` monochrome aurora image without sacrificing wordmark legibility or mobile composition.
- Make the homepage state Substrate's product thesis concretely: owned machines, durable memory, source-grounded AI, and software that preserves continuity and control.
- Give the below-fold page one memorable, restrained motion sequence that turns the hero's organic energy into an architectural product narrative.
- Make continuation below the full-screen hero unambiguous and actionable.
- Preserve static generation, accessibility, reduced-motion behaviour, and good image-loading performance.

**Non-Goals:** see `proposal.md`. In particular, this is not a CMS, archive browser, commerce surface, or automatic publishing pipeline.

## Decisions

### Use a series index plus dedicated series routes

`/photography` is the stable entry point. It contains a short first-person introduction and one full-width series entry at launch. `/photography/iceland-aurora` contains the actual sequence. This avoids redesigning the URL structure when a second body of work is ready.

Alternative considered: render the only gallery directly at `/photography`. Rejected because the route would later have to change meaning or become an increasingly long mixed-series page.

### Keep content static and typed

Each series is represented by a small TypeScript manifest containing slug, title, date/location line, description, cover image, ordered images, dimensions, alt text, and optional short captions. Image files live under `public/photography/<slug>/`. The route is statically generated; there is no runtime data source.

Alternative considered: MDX or a headless CMS. Rejected because the gallery needs structured image metadata and sequence, while Hugo will publish infrequent curated batches. A CMS adds an editorial system where a folder and manifest are sufficient.

### Use editorial pacing, not masonry

The Iceland page uses a near-black canvas and a linear sequence. A recognisable colour landscape opens the series, the sequence moves into increasingly abstract aurora motion, the black-and-white photographs form the central visual act/crescendo, and the wide landscape frame `02136` returns the viewer to place at the close.

Images render predominantly as large single frames with generous vertical space. Rare diptychs are allowed only where two frames create a deliberate visual relationship; the default is not a grid. Captions stay secondary and optional. The introduction is short and personal, not a technical essay or marketing copy.

The initial edit targets 12–18 images. Five-star ratings identify candidates, but inclusion and order are based on sequence, variation, and visual rhythm. Near-duplicate colour/B&W treatments do not both ship unless their pairing is intentionally used.

### Provide a focused, accessible full-screen viewer

Selecting an image opens a full-screen near-black viewer. It supports visible close/previous/next controls, `Escape`, arrow keys, focus management, and horizontal touch/pointer swipe navigation. Navigation does not wrap: the previous control is disabled on the first image and the next control is disabled on the last, preserving the authored beginning and ending. The underlying sequence remains available as normal page content; the viewer enhances rather than gates access. Motion is limited to restrained opacity/position transitions and is disabled under reduced motion.

Alternative considered: no viewer. Rejected because the source photographs contain texture and star detail that the editorial page width cannot fully show. Alternative considered: a feature-heavy carousel. Rejected because it would make the viewer the primary experience and add controls the series does not need.

### Art-direct the homepage hero around `02129-3`

The hero uses `20260323_012442_A7RV_02129-3.jpg` as the source. The implementation may produce dedicated web derivatives and responsive crops from that source. Desktop, tablet, and portrait mobile must each be visually reviewed; a single untested centered `object-cover` crop is not acceptable.

The overlay is image-specific, not constrained to the previous material opacity. It may combine overall dimming, a local radial/linear gradient behind the centered wordmark, edge vignette, and the existing subtle noise layer. The acceptance criterion is simultaneous: the aurora remains visibly exciting and inviting, while the white logo and both copy lines remain effortlessly legible. The canonical logo and text remain real DOM/image assets above the photograph.

This intentionally extends the locked design system. `DESIGN_SYSTEM.md` will gain an **authored photographic atmosphere** category distinct from the existing low-opacity stock/material textures. It permits Hugo's own photographs on Substrate parent-brand surfaces with image-specific opacity/crop/overlay, while retaining the existing rule that real logo, copy, UI, and product proof sit above the image. Product-specific pages do not inherit a photograph automatically.

Parallax remains restrained and may be reduced if it makes the already kinetic photograph feel restless. Reduced-motion users receive a static final composition.

### Sharpen the hero without crowding the photograph

The primary hero line remains `A foundational systems company.` It gives Substrate a confident category without competing with the wordmark or photograph. The secondary line changes from the repetitive `Software infrastructure for durable systems.` to:

`Owned machines. Durable memory. Source-grounded AI.`

The three compact phrases map to Endstate, Exomem, and Q while remaining a company thesis rather than a feature list. The line may wrap responsively, but it remains visually subordinate to the primary statement and must not crowd the `Explore ↓` affordance at portrait-mobile sizes.

Alternatives considered:

- `Machines you control. Memory that persists. AI grounded in sources.` is more explanatory but too long and less declarative for the first screen.
- `Setups restored. Context preserved. Answers grounded.` is elegant but describes the present product set more narrowly than the parent company.
- Replacing the primary line as well was rejected because the existing category statement has authority and the problem is repetition in the secondary line, not the hierarchy itself.

### Rewrite the homepage as a product thesis

The body changes from abstract company axioms to one coherent argument. Immediately below the hero, the thesis reads:

> Software should leave you with more control, not less.
>
> Substrate builds systems for continuity—across machines, knowledge, and the memory our tools carry forward.

The following large-format sequence replaces the existing four axioms:

> Your AI should show its sources.
>
> Your setup should survive the machine.
>
> Your memory should outlive the session.

Each statement points to a real product without naming it prematurely. The approved Fable order deliberately matches the flagship-first product order Q, Endstate, Exomem one-for-one:

- **Q:** `Source-grounded AI for content libraries. Turn original material into a branded knowledge system with answers that cite their sources.`
- **Endstate:** `Local-first Windows setup and restore. Capture your apps and settings once, then rebuild a fresh machine in minutes.`
- **Exomem:** `Durable memory for AI agents, built on Markdown you own. Carry context across sessions without surrendering the source.`

B2B contracting remains discoverable through the existing Work/contact surfaces but does not shape the homepage narrative. Photography and writing remain quiet personal/editorial surfaces, not products.

### Port the approved Fable handoff faithfully

The Fable/Claude Design handoff approved on 2026-07-16 supersedes the first-pass generic spine and statement-pulse treatment. The handoff README and its five reference captures define visual fidelity; this design records the production constraints. If the raw `.dc.html` conflicts with the README or this OpenSpec, the README/OpenSpec governs. In particular, the raw prototype's new-tab behavior for Endstate and Exomem is not authoritative.

The page uses one motion concept: the aurora supplies organic energy, and the below-fold experience resolves it into structure.

#### Hero and afterglow

- Preserve the production responsive `<picture>`, approved crops, wordmark, copy, fine-pointer parallax, and `Explore ↓` target.
- Add `Iceland · March 2026` as a quiet `/photography` link at right `20px`, bottom `40px`, 11px uppercase with `0.14em` tracking; it may be hidden below 640px.
- Put the dissolve inside the hero: `20vh`, transparent at 0%, `rgba(5,5,5,0.5)` at 58%, and `#050505` at 100%.
- Add a decorative afterglow at the start of the below-fold section, flipping the aurora vertically, using object position `44% 46%`, opacity `0.06`, blur `1.5px`, height `min(88vh, 860px)`, and mask stops `black 0%`, `rgba(0,0,0,0.5) 36%`, `rgba(0,0,0,0.14) 62%`, `transparent 84%`. It is `aria-hidden`, non-interactive, lazy/async, and not a new eager/LCP image. Use a dedicated low-resolution derivative no larger than 180 KB transferred rather than requesting another full hero derivative.

#### Editorial composition

- The narrative column is centered at `max-width: 880px` with `24px` horizontal padding and CSS variables `--sx: clamp(6px, 3vw, 20px)` and `--pad: clamp(44px, 8vw, 92px)`.
- The thesis is left aligned at `margin-left: var(--pad)` with top padding `clamp(110px,16vh,170px)`. Its headline is `clamp(30px,4.4vw,56px)`, weight 300, `-0.025em` tracking, 1.14 line-height; support is `clamp(16px,1.35vw,19px)`, weight 300, 1.7 line-height, 28px top margin, and 560px maximum width. `not less` does not break across lines.
- Principles are a semantic ordered list with order AI, setup, memory so `01`, `02`, and `03` map directly into Q, Endstate, and Exomem. The list uses `clamp(100px,15vh,170px)` top and `clamp(90px,13vh,150px)` bottom padding with `clamp(84px,13vh,140px)` gaps. Statements are `clamp(26px,3.4vw,42px)`, weight 300, `-0.02em` tracking, 1.22 line-height. Each principle has an 11px spine node and a quiet connector hairline.
- Products are full-width bordered index rows, not floating cards. Each row repeats the numbered principle, product name, approved description, and `Learn more` direction. Rows use `clamp(36px,5vh,52px)` vertical padding; names are `clamp(30px,3.8vw,46px)` and descriptions are `clamp(16px,1.3vw,19px)` with 1.65 line-height. The first product border begins where the spine terminates.
- Q uses `https://useq.ai`, `_blank`, and `noopener noreferrer`; Endstate and Exomem use internal `/endstate` and `/exomem` routes with no new browsing context.
- A centered closing axiom reads `Systems precede products.` before the global footer.
- The footer retains all eight links: Work, Writing, Photography, Q, Endstate, Exomem, GitHub, and LinkedIn. Its inner container is 880px with `60px 24px` padding, the wordmark is 14px high, and the layout wraps without horizontal overflow.
- The handoff's hierarchy is preserved, but small functional text cannot use `#525252` on `#050505`. Product eyebrows, Learn more links, footer navigation/copyright, and focus indicators use at least `#7a7a7a` (or an equivalent contrast of 4.5:1); the focus ring uses at least `#a3a3a3`. Large display text and decorative strokes retain the handoff values.

#### Converge signature spine

- The spine zone wraps the thesis, principles, and Products heading. Products rows, closing axiom, and footer remain outside it.
- SSR renders a straight 1px static fallback line. JavaScript enhancement replaces it with one SVG containing three organic strands, a 150px tail, and a 15px light bead.
- The bead represents the boundary between organic and resolved structure and sits at `viewportHeight * 0.55` while the zone crosses the viewport.
- Sample each path every 18px. Organic amplitude is `30 * (1 - y/H)^1.35`, so all strands taper into a straight product-table landing. The convergence factor is `smoothstep(clamp01((y - beadY) / 340))`.
- The center strand uses phase 0. Side strands use phases `2.1` and `4.4`, `0.8×` amplitude, and offsets of `±24 * a`. Wave terms are `0.7*sin(y*0.017 + t*0.000585 + phase)` plus `0.5*sin(y*0.006 - t*0.00045 + 0.6*phase)`. Behind the bead all three collapse to x=40. Every path begins `M 40 0` and ends `L 40 H`.
- Primary/side spine strokes use white alpha `0.17`/`0.10` at 1px. The tail runs from `beadY - 150` to the bead with `rgba(250,250,250,0.4)`, 1.5px rounded stroke, and 0.5 opacity. The 15px bead uses the handoff radial core and `0 0 22px 6px rgba(250,250,250,0.16)` glow. Nodes use a 1px white-alpha 0.28 border on `#050505`, fill to `#fafafa`, and transition over 500ms with `cubic-bezier(0.33,1,0.68,1)` after the bead reaches their measured centers; they deactivate when scrolling back.
- The client island measures zone height and node centers at mount and through ResizeObserver. During animation it reads the zone rectangle once per active frame, writes only SVG path data and transforms, skips work when the zone is more than 120px outside the viewport, and cleans up rAF, observer, media-query, and pointer listeners.

#### Progressive reveal and fallbacks

- Thesis lines, principles, Products heading/rows, and axiom use the handoff's 14px fade-up reveal with `0.9s cubic-bezier(0.16,1,0.3,1)` timing and declared delays. The footer is not a reveal target.
- Content is visible in SSR and without JavaScript. After hydration, only elements still below `0.92 * viewportHeight` may be hidden and observed. The single IntersectionObserver uses threshold 0.2 and root margin `-32px`; each item reveals once.
- Without JavaScript, content is visible, the animated SVG/bead are absent, the straight fallback line remains, and nodes remain unfilled. Under `prefers-reduced-motion`, reveals and parallax are disabled, the animated SVG/bead are hidden, the straight fallback line remains, and all nodes are filled without glow. Live preference changes switch between these states without a reload. No content or relationship depends on motion.
- Hero parallax remains owned by the current Framer Motion implementation. The spine owns only its own rAF loop; these systems are not merged.

There are no particles, glowing orbs, fake infrastructure diagrams, continuous decorative loops, pinned-scroll traps, or WebGL dependency.

### Replace decoration with an explicit scroll action

The current unlabeled vertical line is removed. The hero instead ends with a visible `Explore ↓` anchor targeting `#content` on the first meaningful content section below the hero (the current Hook section, after the decorative transition). It has an accessible name, keyboard focus state, and at least a 44×44 CSS-pixel interaction area. A subtle downward cue may animate by a few pixels when motion is allowed; no animation is required to understand it.

### Keep discovery quiet

Photography is added to the global footer and to `/work` under “Elsewhere.” It is not added to the homepage hero copy or treated as a product. The sitemap includes both photography routes. Metadata identifies Hugo as the photographer and describes the Iceland aurora series plainly.

The root asset metadata and `ATTRIBUTIONS.md` are updated so Adrien Olichon/Pexels is no longer described as the active hero author. The default `/api/og` treatment also switches from `metal-structure-dark.jpg` to the authored aurora asset, keeping the public thumbnail consistent with the new homepage identity. If the stock file has no remaining references after that change, it is removed rather than retained as an unattributed dead asset.

## Image and Performance Strategy

- Preserve the original edited JPEGs outside the repo; project assets are derivative web exports.
- Retain an embedded sRGB-compatible profile and avoid accidental colour/tone shifts.
- Use responsive image sizing, explicit dimensions/aspect ratios, lazy loading below the fold, and a high-priority cover/hero only where it affects LCP. On a series page, only the first in-flow photograph is priority/eager; later in-flow photographs remain lazy. The viewer may preload the current image and at most its immediately adjacent images, never the full series.
- Use lightweight placeholders or a neutral near-black reserve so layout never jumps while images load.
- Do not ship all 51 exports or multiple redundant treatments merely because they exist.
- Verify image weight at desktop and mobile breakpoints during implementation; visual fidelity wins over aggressive compression, but no page should eagerly download the full series.

## Accessibility

- Every displayed photograph has useful alt text; decorative hero imagery uses empty alt text because the logo/copy carry the meaning.
- Viewer controls are keyboard reachable and screen-reader named.
- Every in-flow image opener is a semantic button with an accessible name. The viewer exposes labelled modal-dialog semantics, contains focus, makes the underlying page non-interactive while open, locks background scrolling, and announces the current position as “image N of total.”
- Focus returns to the invoking image when the viewer closes.
- Reduced-motion preferences disable gallery/viewer transitions and hero parallax/scroll-cue movement.
- Text and controls meet WCAG AA contrast against the tuned hero/gallery backgrounds.

## Risks / Trade-offs

- **The aurora reads as energy rather than infrastructure.** Accepted: authorship and invitation are the desired improvement. The restrained monochrome treatment, canonical wordmark, and controlled overlay keep it inside the Substrate system.
- **The kinetic focal point can compete with centered copy.** Mitigated through art-directed crops and local overlay gradients; verified at representative breakpoints before replacing the current asset.
- **A photography page can look like an unrelated hobby portfolio.** Mitigated by the short personal framing, shared Substrate chrome, footer-level discovery, and series-based curation.
- **High-resolution galleries can become heavy.** Mitigated by static manifests, responsive sources, lazy loading, explicit sizes, and no eager full-series download.
- **A custom viewer can become overbuilt.** Scope is fixed to view, previous, next, close, keyboard, focus, and touch/pointer navigation. No zoom engine, social sharing, comments, or slideshow.

## Verification

- OpenSpec strict validation passes.
- Production build succeeds and statically emits `/photography` and `/photography/iceland-aurora`.
- Responsive screenshots verify the homepage hero, thesis, structural statement sequence, products, scroll action, index, sequence, and viewer at 1440×900 desktop and 390×844 portrait-mobile viewports, with an additional tablet crop check.
- The hero is checked for wordmark/copy contrast and crop integrity at representative desktop, tablet, and portrait mobile viewports.
- Browser checks confirm the hero text, thesis, three statements, and product descriptions match the approved copy; the motion sequence uses natural document scroll and does not pin or block progression.
- Keyboard-only checks cover opening/navigating/closing the viewer and activating `Explore ↓`.
- Reduced-motion checks confirm static hero, homepage narrative, product, and viewer behaviour.
- Network inspection at the named desktop/mobile viewports records requested derivatives and transferred bytes, and confirms only the hero/cover or first in-flow series image is eager; the unopened viewer does not preload the full series.

## Bounded Editorial Decisions

The final 12–18 image manifest, index cover, rare diptych choices, short introduction, and optional captions are intentionally resolved during asset curation. They do not change the architecture. The manifest is locked and visually reviewed as a complete sequence before route implementation proceeds, so layout work does not chase a moving edit.

## Open Questions

- None. The route structure, visual direction, hero image, overlay flexibility, scroll affordance, future curated-series model, viewer boundaries, and OG/attribution treatment are approved. The bounded editorial decisions above are part of implementation curation, not unresolved architecture.
