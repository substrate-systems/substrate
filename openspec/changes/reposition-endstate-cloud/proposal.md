# Change: Reposition the managed service as Endstate Cloud and separate project support from paid plans

## Why

Three public-facing problems, one root cause: the storefront names things after
their implementation rather than after what a reader gets.

- "Hosted Backup" describes a mechanism (a backup, hosted) rather than an
  outcome, and it reads as a feature of the product rather than as the one
  optional managed service. The service needs a name that sits beside the
  product: **Endstate Cloud**.
- "Supporter License" reads as a licence. It is not one — it grants nothing,
  unlocks nothing, and creates no entitlement. Calling a voluntary contribution
  a licence invites a reasonable buyer to expect something in return, and puts
  it in the same visual grammar as the plans that do deliver something.
- People who want a specific application supported have no way to ask, and no
  statement of what funding that work would and would not buy.

## What Changes

- Rename the managed service to **Endstate Cloud** in all public copy: pricing,
  Terms, the account portal, the claim flow, transactional email, SEO metadata,
  structured data, and the LLM-facing text files. Internal identifiers are
  deliberately unchanged and enumerated in `docs/naming.md`.
- Replace **Supporter License** with **Support Endstate**, presented as a
  voluntary contribution rather than a plan. Contribution amounts become a
  config-driven array (€10 Supporter, €29 Founding Supporter, €89 Patron) that
  renders a tier only when its Paddle price ID is configured, plus a Custom
  Project Sponsor path that routes to the existing founder mail contact.
- Add `/endstate/sponsor-an-integration`: what integration sponsorship funds,
  how it differs from package installation, and what a completed sponsorship
  does and does not imply. Intake reuses the existing contact pipeline as a
  structured `mailto:` link. Priced by quotation.
- Link the new page from the Endstate footer and the sitemap.

Not a breaking change. No price changes: €4/mo, €40/yr, and €89 one-time are
unchanged. No new entitlement, feature flag, backend, API route, or table.

## Impact

- Affected specs: `endstate-cloud-service` (new), `endstate-project-support`
  (new), `endstate-integration-sponsorship` (new)
- Affected code:
  - `src/app/endstate/page.tsx`, `src/app/endstate/_shared.tsx`,
    `src/app/endstate/layout.tsx`
  - `src/app/endstate/supporters/{page,layout}.tsx`,
    `src/app/endstate/supporters/SupportTiers.tsx` (new)
  - `src/app/endstate/sponsor-an-integration/{page,layout}.tsx` (new)
  - `src/app/endstate/claim/[token]/page.tsx`
  - `src/app/terms/page.tsx`, `src/app/account/{page,AccountView}.tsx`
  - `src/lib/support-tiers.ts` (new), `src/lib/paddle.ts`,
    `src/lib/email-templates/claim.ts`, `src/lib/structured-data.ts`
  - `src/app/api/license/webhook/route.ts`, `src/app/sitemap.ts`
  - `public/llms.txt`, `public/llms-full.txt`, `README.md`,
    `docs/naming.md` (new), `docs/runbooks/support-endstate-paddle-setup.md` (new)
- Requires no migration and no data change.
- Cross-repo compatibility: current desktop releases label the section
  "Endstate Cloud". Claim instructions retain a narrow parenthetical for older
  releases that still display "Hosted Backup", tracked in `docs/naming.md`.
