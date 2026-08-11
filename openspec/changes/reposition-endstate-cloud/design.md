## Context

This is a positioning change to a live storefront that already takes money. Two
constraints shape every decision below.

**The Endstate Principles are load-bearing.** They are public commitments
(`github.com/Artexis10/endstate/blob/main/PRINCIPLES.md`) that can be
strengthened but never weakened. Principle 1 says the local product is free and
never reduced; principle 3 says a subscription gates managed services and
nothing else. New copy therefore cannot describe anything as "unlocked" by
payment, and a contribution tier cannot acquire features without breaching the
contract the project published.

**Renaming a service is not renaming its wiring.** Paddle price IDs, webhook
destinations, API paths called by shipped desktop clients, a capabilities key
the engine gates on, and columns in a live database all carry the old name.
Every one of them is configuration or a contract with something already in the
field.

## Goals / Non-Goals

**Goals**

- Public copy names the managed service **Endstate Cloud** and the voluntary
  contribution **Support Endstate**, consistently across pages, email, metadata,
  and machine-readable text.
- Contribution amounts are configuration, so the page ships before the smaller
  Paddle prices exist and grows without a code change.
- A reader who wants a specific application supported can tell what that funds,
  what it does not, and how to ask.

**Non-Goals**

- No change to any price. €4/mo, €40/yr, and €89 one-time are unchanged.
- No entitlement, licence key, feature flag, GUI payment check, supporter-only
  functionality, private call, or priority-engineering promise. None exist; none
  are added.
- No Teams, technician dashboard, SSO, fleet management, org permissions,
  private-module distribution, or telemetry.
- No new backend, API route, database table, or third-party form. No
  marketplace, pooled funding, bounty accounting, vendor certification, or
  automated pricing.
- No renaming of internal identifiers.

## Decisions

### Rename public copy only; enumerate every retention

Public strings change. Env vars, `src/lib/hosted-backup/`, `/api/backups/*`,
`HostedBackupCadence`, `openHostedBackupCheckout`, the `"paddle-hosted-backup"`
discriminant, the `hostedBackup` capabilities key, DB columns, and the
`hosted_backup` / `supporter` analytics identifiers all keep their names.

Each retention is recorded in `docs/naming.md` with the reason, because an
undocumented mismatch reads as an incomplete rename and invites a future
contributor to "finish" it. Analytics identifiers are included for a subtler
reason: renaming them is non-breaking at build time and silently splits one
funnel into two series in historical data.

_Alternative considered:_ rename everything and migrate. Rejected — the
capabilities key is a cross-repo wire contract with the Go engine, and the
Paddle env vars are configured in a hosting environment this change cannot see.
The blast radius is large and entirely invisible to users.

### Terms keeps a "(previously Hosted Backup)" parenthetical

On first use in the definitions section only. Existing customers hold receipts
and card statements naming the old service; a reader reconciling a charge needs
one bridge, in the document that governs the charge. Everywhere else the old
name is simply gone.

### Contribution tiers are a config-driven array, not committed price IDs

€10 and €29 do not exist in Paddle yet. `src/lib/support-tiers.ts` defines the
tiers and resolves each price ID from a literal `process.env.NEXT_PUBLIC_*`
reference; `configuredSupportTiers()` filters to the ones that resolve. A tier
with no price ID does not render, so the page ships correct today and grows when
the prices are created — no deploy-blocking dependency on external setup, and no
button that opens a broken checkout.

Two details are deliberate:

- Price IDs are resolved **per call**, not captured at module load. Next.js
  substitutes `NEXT_PUBLIC_*` at build time either way, but a module-load
  snapshot makes server-side behaviour depend on import order and makes the
  webhook untestable across configurations.
- Each lookup is a literal member expression rather than a computed key,
  because a computed lookup resolves to `undefined` in the browser bundle.

_Alternative considered:_ calling the Paddle API to create the products. Ruled
out by the brief and independently wrong — catalogue creation is a one-time
administrative act, not something application code should perform. The steps are
written down in `docs/runbooks/support-endstate-paddle-setup.md` instead.

### The webhook matches against every configured support price

`/api/license/webhook` previously matched one price ID and returned a retryable
500 when it was unset. It now collects all configured support price IDs,
including the unchanged `NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER`, and
matches against the set. The €89 path is bit-for-bit unchanged in behaviour;
newly configured amounts are accepted the moment they are configured. The
handler stays recognition-only — no key, no entitlement.

### Support moves off the pricing grid, onto the supporters page

The `/endstate` pricing grid keeps one **Support Endstate** card showing the
lowest configured amount ("from €X") whose call to action is "Choose an amount",
linking to `/endstate/supporters#support`. The actual contribution choices and
their checkouts live on the supporters page.

This is the separation the change is for. Four contribution cards inside the
plan grid would put a donation in the same visual grammar as a subscription,
which is the confusion "Supporter License" already caused. It also keeps the
grid at four cards rather than seven, and puts the contribution choices next to
the list of people who already contributed — the strongest available context for
the decision.

The supporters page keeps parsing the `## Supporters` heading from
`SUPPORTERS.md` in the engine repository. That contract is untouched, and
recognition stays opt-in and consent-based.

### Custom Project Sponsor and integration sponsorship intake are both `mailto:`

Neither gets a form, an API route, or a table. Both build a structured
`mailto:founder@substratesystems.io` link with a prefilled subject and body — the
integration one collecting exactly the nine fields needed to scope a quote.

A larger contribution and an integration scope are both conversations. A form
would imply a pipeline behind it (a queue, a status, a response time) that does
not exist, and inventing one to look credible is the failure mode this whole
change is correcting.

### Integration sponsorship is priced by quotation

No public price. An application with two settings files and one package identity
is not the same work as one with per-edition registry layouts and a licence blob
that must not be copied. The page says so and asks for a quote request.

The page states the limits explicitly rather than leaving them to be inferred:
community contributions continue, sponsorship buys priority and explicit scope
and verification, public integrations become part of free open-source Endstate,
private organisational and vendor work is by quotation, and a completed
sponsorship implies no lifetime maintenance — ongoing compatibility guarantees
need a separate agreement.

### Cloud copy stays within the proven backup boundary

The approved outcome line is used as written, and the tier's feature list says
The public tier says "Your encrypted setup history, ready on another Windows
PC" and "Keep protected versions without managing storage yourself". It is
limited to the Endstate application list and supported non-secret settings;
it does not promise generic personal-file backup or automatic capture.
actually implements, behind an explicit one-time consent prompt. The headline
states the outcome; the bullet states the mechanism and its opt-in nature, so
the tier cannot be read as continuous background sync.

### The in-app fallback instruction accommodates older desktop releases

Current `endstate-gui` releases label the section "Endstate Cloud". The claim
email and claim page use that current name and add "shown as Hosted Backup in
older versions" so an existing buyer running an older release can still find
the correct section. `docs/naming.md` names both compatibility strings and the
test that pins them.

## Risks / Trade-offs

- **Older desktop releases retain the previous label** → the Terms parenthetical
  and narrowly qualified claim instruction preserve navigation compatibility.
- **Support behind an extra click** from `/endstate` → the pricing card states
  the entry amount up front, and the destination pairs the choice with the
  people who already contributed.
- **Retained identifiers read as an unfinished rename** → `docs/naming.md` plus
  a README content-discipline rule, so the mismatch is documented policy rather
  than apparent oversight.
- **Sponsorship enquiries could be read as a maintenance commitment** → the page
  states the opposite in its own section, and states that ongoing compatibility
  requires a separate agreement.

## Migration Plan

None. No schema change, no data change, no configuration change required to
deploy. `NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_10` and `_29` are optional: unset,
their tiers do not render.

Rollback is a revert. Nothing here writes state, and the retained identifiers
mean a revert cannot orphan a payment, a subscription, or a stored record.

## Open Questions

- The `hostedBackup` capabilities key remains a wire contract even though the
  current GUI label is Endstate Cloud.
- Whether integration sponsorship eventually warrants its own Terms section. It
  is quotation-based and every engagement is individually scoped, so the page's
  own statements are currently sufficient.
