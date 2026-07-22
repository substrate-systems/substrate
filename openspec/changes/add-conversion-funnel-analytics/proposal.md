## Why

Endstate is taking live launch traffic — thousands to tens of thousands of Reddit visitors — against an analytics integration that, until PR #45, captured a single anonymous `$pageview` and nothing else.

Wave 1 (PR #45, merged 2026-07-21) closed the acquisition half: same-origin `/ingest` so ad blockers stop silently biasing the sample, `download_clicked` with UTM attribution, and server-side `download_served` / `download_failed` that survive the 302 to GitHub.

The revenue half is still entirely dark. Four of ten funnel steps are instrumented; the six that are not are precisely the ones that carry money. Today the site can answer *"which subreddit drove downloads"* but not *"did any of them pay."* Checkout emits nothing on intent, success, or failure. Paddle webhooks log to console only. No `identify()` call exists anywhere, so under `person_profiles: "identified_only"` PostHog holds no person records at all — no retention, no cohorts, no person-property breakdowns.

The web visitor and the paying customer are two disjoint identity islands, and joining them is the work here. The desktop app is deliberately not a third: Endstate's CLI and GUI carry no telemetry, which is a published commitment, so the observable journey ends at the web boundary by design.

The cost compounds while traffic runs: events not captured during the launch are not reconstructable afterwards.

## What Changes

- **Server-side capture for revenue events.** `posthog-node` (already a dependency from Wave 1) captures Paddle subscription webhooks, license webhooks, and cron outcomes. Webhook handlers must still acknowledge Paddle when analytics fails.
- **Identity resolution.** `posthog.identify()` at claim redemption and license activation, creating the first person profiles on the project. Existing anonymous events stitch to the resulting person.
- **Identity threading into the payment provider.** `distinct_id` carried through Paddle `customData`, joining the web session to the checkout so a purchase can be attributed to the channel that produced it. **The `endstate://` deep link is explicitly excluded** — Endstate's CLI and GUI carry no telemetry as a published commitment, and nothing may be pushed into them to enable a later join.
- **Checkout funnel.** Capture at all four Paddle seams — intent, `CHECKOUT_COMPLETED`, init failure, open failure — plus the transaction-opener failure and retry paths.
- **Product-signal capture.** Debounced search capture on `/endstate/apps`, including the zero-result branch, which records which apps users want and cannot find.
- **Session replay**, enabled only behind a masking pass, since claim and account surfaces render recovery keys and tokens.
- **Configuration verification.** Confirm `NEXT_PUBLIC_POSTHOG_HOST` resolves to the EU host in every Vercel environment, not just production — the code default is US, so an unset preview environment misroutes silently. (Production verified EU on 2026-07-21; preview and development are unverified.)

No user-facing behaviour changes. No breaking changes.

## Capabilities

### New Capabilities
- `conversion-analytics`: What the site must observe across the Endstate funnel — which events exist, what identity each carries, which failures are recorded — and the guarantees that observation must not violate (privacy filtering, and never degrading the flow being measured).

### Modified Capabilities
<!-- None. Wave 2 adds observation to hosted-backup-operations and licensing flows without changing their requirements; existing behaviour is unaltered. -->

## Impact

**Code**
- `src/lib/analytics.ts`, `src/lib/analytics-server.ts` — extend the existing event registry and `captureServer` / `distinctIdFromRequest` helpers rather than introducing parallel patterns
- `src/lib/paddle.ts`, `src/app/endstate/BuyButton.tsx`, `src/components/PaddleTransactionOpener.tsx` — checkout seams
- `src/app/api/webhooks/paddle/route.ts`, `src/app/api/license/webhook/route.ts`, `src/app/api/license/activate/route.ts` — server captures and identify
- `src/app/endstate/claim/[token]/ClaimClient.tsx` — identify and deep-link threading
- `src/app/endstate/apps/AppsList.tsx` — search capture
- `src/app/providers.tsx` — session replay config, gated on masking

**Risk surface**
Billing, authentication, and webhook acknowledgement paths. Analytics failure must never fail a checkout, an activation, or a webhook ack. This is the defining constraint of the change.

**Privacy**
`src/lib/exomem-hosted/privacy.ts` must keep holding: `filterPostHogCapture` drops events whose current-or-event URL is a private Exomem path, and those routes never mount the SDK. Session replay materially raises this risk and is therefore gated.

**Dependencies**
None new. `posthog-node` and `posthog-js` are both already present.

**Cost**
Autocapture was enabled in Wave 1 and scales with launch traffic. Adding replay compounds it. Event volume against the PostHog plan should be checked before replay is switched on.
