## Context

Wave 1 (PR #45) established the analytics substrate: an `/ingest` same-origin proxy, a client event registry in `src/lib/analytics.ts` with a `markAnalyticsReady` guard, and a server helper pair in `src/lib/analytics-server.ts` (`captureServer`, `distinctIdFromRequest`) that reads the posthog-js cookie from the raw `Cookie` header and flushes against an 800 ms bound.

Wave 2 extends that substrate into paths that are materially riskier than a download redirect: Paddle checkout, webhook handlers that must acknowledge a payment provider, licence activation, and the claim flow that hands off to the desktop app. The defining constraint is that none of these may be made less reliable by observing them.

Two structural facts shape the design:

1. **`person_profiles: "identified_only"` means no person exists until `identify` is called.** Anonymous events still carry a `distinct_id` and still work in funnels — the earlier claim that this "blocks every funnel" was wrong — but person properties, cohorts, and retention need a real identify call. There is currently not a single one in the codebase.

2. **Two joinable identity islands, and one that must stay separate.** A browser has an anonymous `distinct_id`; Paddle knows a customer id. Joining those two is the work. The desktop app is deliberately *not* a third: Endstate's CLI and GUI carry no telemetry, which is a published commitment, so there is nothing on that side to join to and nothing may be pushed into it to enable a join later.

## Goals / Non-Goals

**Goals:**
- Every checkout outcome observable, failures included
- Person profiles exist for users who claim or activate
- A visitor's identity survives the hops into Paddle and into the desktop app
- Subscription lifecycle visible without reading Vercel logs
- Unmet demand on the supported-apps page recorded
- No regression in billing, auth, or webhook acknowledgement

**Non-Goals:**
- Enabling session replay in this change — the masking pass is specified but gating it is the deliverable, not switching it on
- **Any observation of the local product, or any identifier passed into it.** Endstate's CLI and GUI transmit nothing about the user, and no analytics work may erode that. This constrains the installed application; it does not constrain the website, whose own traffic is exactly what this change measures
- Dashboards, funnels, or alerting inside PostHog — this produces the event stream, not the analysis
- Retroactive reconstruction of launch traffic already spent. It is gone.

## Decisions

### Identity is established on the client, and the server follows it

`identify()` is called client-side at claim redemption, because only the browser holds the anonymous `distinct_id` that must be stitched to the new identity. Server-side captures then use the same application user id as `distinctId`, so both halves converge on one person.

*Alternative considered:* server-only identity, capturing everything with the user id. Rejected — it silently orphans the visitor's entire pre-signup anonymous history, which is exactly the acquisition data Wave 1 was built to collect. The join between "arrived from r/opensource" and "paid" depends on that stitch.

*Alternative considered:* `alias()` instead of `identify()`. Rejected — aliasing is the legacy path, is not reversible, and PostHog's own guidance is to prefer `identify` with `$anon_distinct_id` handled by the SDK.

### The anonymous id is threaded into Paddle, and nowhere else

Where the payment boundary is crossed before identity exists — a checkout opened by a visitor who has not signed up — the **anonymous** `distinct_id` is threaded through Paddle `customData`. Server events then attribute to that same id.

This means a purchase by a never-identified visitor still lands on the same person as their landing-page view. Absent the thread, it would create a second, unjoinable person and the channel-to-revenue link would be permanently lost.

**The `endstate://` deep link is explicitly excluded from this.** An earlier draft of this design proposed threading the identifier there too. That was wrong on three counts: it pushes tracking into a product that publicly commits to carrying none; it buys nothing, because the app transmits nothing that could ever report the identifier back; and the link is user-visible, so a reader inspecting it would find a tracking id inside a "no telemetry" handoff. The third is the disqualifying one — a published constraint holds its value only while it is never quietly bent. See the credible-commitment-via-published-constraints pattern, the same structure as the hosted-backup "we cannot decrypt your data" commitment.

When no identifier is available (SDK blocked, first touch), the event is captured as unresolved rather than dropped, and carries a flag so it can be excluded from funnels instead of skewing them. Wave 1 already established this convention with `identity_resolved`.

### Webhook captures happen after the state change and cannot fail the ack

Order inside a webhook handler is: verify signature → persist state → capture → acknowledge. The capture sits after persistence so a capture failure can never prevent the business effect, and `captureServer` already swallows its own errors and bounds its flush.

*Alternative considered:* capture before persisting, to record attempts as well as successes. Rejected — it inverts the risk, letting an analytics path sit upstream of a payment state transition.

*Alternative considered:* `after()` for post-response capture. Rejected on evidence from Wave 1: `after()` throws outside a request scope, which makes route handlers untestable when invoked directly, and a deferred promise can be stranded by a serverless freeze. Both fail silently, which is the worst property for the events this change exists to record.

### Event names extend the existing registry

New names go in the `AnalyticsEvent` const in `src/lib/analytics.ts`. Server-only event names live alongside them so the taxonomy is greppable in one place even though the two capture paths differ. No parallel constants file, no inline string literals.

### Search capture is debounced on settle, not throttled

The supported-apps search fires per keystroke. Capture is debounced so one search intent produces one event, keyed on the settled query. The zero-result branch is captured as a distinct event rather than a property, because unmet demand is the signal worth querying directly and burying it in a property makes it easy to miss.

### Replay masking is specified but not switched on

Claim and account surfaces render recovery keys and tokens. Masking is defined here and enforced by contract test; enabling replay is a follow-up once the masking is verified against those surfaces. Shipping replay and masking in one change would put a DOM-recording feature live on the same deploy that first defines its own safety rules.

### Region configuration is verified per environment, not assumed

Production was confirmed EU on 2026-07-21 by reading `ui_host` from the deployed bundle. Preview and development are unverified. Because the code default is US, an environment missing the variable misroutes into a different region silently — no error, just absent data. This gets an explicit verification task rather than an assumption.

## Risks / Trade-offs

**Analytics failure degrades a payment path** → Every capture on a billing path is wrapped so it cannot throw; `captureServer` bounds its flush; captures sit downstream of persistence. Contract tests assert a webhook still acks when capture throws.

**Identity stitching lands wrong and merges two real users** → Identify only at claim redemption and licence activation, where the user id is authoritative. Never identify from a value derived from a URL parameter alone, since deep-link parameters are user-supplied.

**A future change quietly appends an identifier to the deep link** → A contract test pins the `endstate://claim` link's parameters, so re-introducing one fails CI rather than shipping. The commitment is easier to erode by increments than by decision.

**Event volume cost** → Autocapture is already on from Wave 1 and scales with launch traffic; Wave 2 adds comparatively few events, but replay would compound it. Volume is checked against the plan before replay is considered.

**Privacy regression via a new automatic capture** → The `before_send` filter is the single chokepoint and already covers every capture mechanism. Any new automatic capture inherits it; the contract test asserts the filter, not individual flags.

**Session replay records secrets** → Not enabled in this change.

## Migration Plan

Additive and reversible. No schema changes, no data migration, no dependency additions.

Deploy order does not matter for correctness: server captures and client captures are independent, and an unidentified person simply produces unresolved events until the identify path ships.

Rollback is per-seam — each capture is an isolated call that can be removed without touching the flow it observes. A full rollback is reverting the change; the Wave 1 substrate stays.

Verification before merge mirrors Wave 1: a local production build with a real key, exercising checkout in Paddle sandbox and confirming events arrive with the expected identity, plus a webhook replay confirming ack behaviour when analytics is forced to fail.

## Open Questions

- Which application identifier is the right `distinct_id` for identify — the hosted-backup user id, or a licence-scoped identifier? They may not be the same person across products, and picking wrong merges two identities that should stay separate.
- Should Exomem surfaces be instrumented in this change, or does the privacy posture argue for keeping Exomem observation deliberately minimal even on its public pages?

*Resolved 2026-07-22:* whether the desktop app has analytics of its own — it does not, and will not. The CLI and GUI carry no telemetry as a published, inviolable commitment.
