# Endstate commercial pages design

## Goal

Bring `/endstate/supporters` and `/endstate/sponsor-an-integration` into the visual language of the main Endstate landing page while preserving every approved product claim, contribution rule, and enquiry path.

Article and legal routes remain quiet, narrow reading surfaces. These two routes are decision and action surfaces, so they use the wider landing-page composition of the same Endstate design system.

## Visual direction

- Reuse the existing Endstate palette, typography, navigation, footer, accent rules, and page-local inline-style approach.
- Use a maximum content width around 1100 pixels for hero and commercial sections.
- Group related content into restrained bordered cards and panels, with copper and teal used for meaningful emphasis rather than decoration.
- Keep the pages server-rendered. Add no new dependencies, global tokens, illustrations, or animation system.
- Preserve semantic heading order, visible focus states, keyboard access, colour contrast, reduced-motion behaviour, and single-column mobile layouts.

## Supporters page

1. A composed hero introduces voluntary support and links to the contribution section.
2. A dignified supporter roster surface displays the canonical opt-in list from `SUPPORTERS.md`. Names expose no contribution amount, transaction data, or inferred tier.
3. Existing supporter options remain the same four commercial paths: Supporter, Founding Supporter, Patron, and Project Sponsor. Their checkout and enquiry behaviour is unchanged.
4. A contained closing note explains that recognition is opt-in and that the complete Endstate product remains free.
5. Fetch or parse failure remains non-fatal, but the empty state is presented as a contained surface rather than a large dead area.

## Sponsor an integration page

1. A strong hero states the outcome and keeps the existing `Request a quote` mailto CTA.
2. A two-column comparison distinguishes application installation from deeper migration support.
3. Three cards explain what sponsorship buys: priority, explicit scope, and verification.
4. Separate grouped sections explain public open-source integrations, private organisational/vendor work, and maintenance boundaries.
5. The final quote panel retains the existing intake fields and mailto pipeline. No form backend, marketplace, automatic price, or new data collection is introduced.

## Boundaries

- Do not modify the main Endstate landing page, articles, terms, privacy, checkout logic, payment identifiers, backend routes, or legal copy.
- Do not add new product promises, fixed sponsorship pricing, supporter entitlements, or public contribution tiers beside the already approved four paths.
- Do not expose James E. Howard's email address, transaction, amount, or internal supporter record. His exact consented public name is the only published datum.

## Verification

- Type-check, lint, format-check, run the repository OpenSpec validator, and build the production site.
- Exercise both routes at desktop and mobile widths, including keyboard focus and no horizontal overflow.
- Confirm the supporter parser renders `James E. Howard` from the canonical Markdown source.
- Capture screenshots of both changed routes for review before merge.
