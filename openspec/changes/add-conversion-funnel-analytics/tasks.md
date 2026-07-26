> **Implementation status — 2026-07-25.** Sections 2, 3, 6 and 7 are complete, plus
> 4.1–4.2 and 9.1–9.2. **Section 5 (identity resolution) is deferred by decision**, not
> forgotten: Hugo chose to ship with anonymous `distinct_id`s only. Funnels work on
> anonymous ids, so the cost is person-property breakdowns and cohorts, and the avoided
> risk is a permanent, invisible identity merge. Task 5.1 as written is additionally
> unsafe — the only identifier available in `ClaimClient.tsx` is the claim token, which is
> a credential and must never become a `distinct_id`. Rewrite 5.1 before implementing it.
>
> Still open: 5.x (deferred by decision) and 9.4–9.6 (manual Paddle sandbox exercise, webhook replay and PostHog volume check — all need credentials or a browser). The analytics-exclusion finding from task 8.1 was **resolved 2026-07-25 as option 2**: autocapture is scoped away from `/account` and `/endstate/claim` via `url_ignorelist`, while pageviews and deliberate events continue. See design.md.
>
> One deviation worth knowing: the event taxonomy lives in `src/lib/analytics-events.ts`
> rather than `src/lib/analytics.ts`. The latter imports `posthog-js`, so server routes
> could not have shared it without bundling the browser SDK. Same single greppable place,
> no bundling cost.

## 1. Resolve blocking decisions

- [x] 1.1 ~~Decide which application identifier is the canonical `distinct_id`~~ — **resolved as: do not identify yet.** Ship anonymous. Revisit when there are enough users for cohorts to be meaningful.
- [~] 1.2 Verify `NEXT_PUBLIC_POSTHOG_HOST` is set to the EU host in **every** Vercel environment — `vercel env ls` on 2026-07-25 shows both PostHog vars set for **Preview and Production only**. Development has neither, so analytics no-ops locally rather than misrouting to the US default — the safe failure. The Preview _value_ is encrypted and still unconfirmed as EU; `vercel env pull --environment=preview` would settle it.

## 2. Extend the analytics substrate

- [x] 2.1 Add Wave 2 event names to the `AnalyticsEvent` registry in `src/lib/analytics.ts`, including server-only names, so the taxonomy stays in one greppable place
- [x] 2.2 Add an `identify` helper to `src/lib/analytics.ts` that no-ops when analytics is not ready, mirroring the existing `capture` guard
- [x] 2.3 Add a helper exposing the current anonymous `distinct_id` for threading across boundaries, returning null when the SDK is blocked or uninitialised
- [x] 2.4 Unit-test the threading helper's null path, since every boundary case depends on it degrading cleanly

## 3. Checkout funnel

- [x] 3.1 Capture checkout intent — implemented in `src/lib/paddle.ts` rather than `BuyButton.tsx`. BuyButton is a generic wrapper that receives an opaque `action`, so it cannot name the product; every checkout path already funnels through `usePaddle`, which can. One seam, all three products.
- [x] 3.2 Capture completion in the existing `CHECKOUT_COMPLETED` callback in `src/lib/paddle.ts`
- [x] 3.3 Capture SDK init failure and checkout open failure in `src/lib/paddle.ts`, each naming its failure stage
- [x] 3.4 Capture the failure and retry paths in `src/components/PaddleTransactionOpener.tsx`
- [x] 3.5 Thread the anonymous `distinct_id` into Paddle `customData` when opening a checkout
- [x] 3.6 Verify a forced PostHog failure does not prevent a checkout from opening or completing

## 4. Server-side revenue events

- [x] 4.1 Capture subscription lifecycle transitions in `src/app/api/webhooks/paddle/route.ts`, placed after state persistence and before acknowledgement
- [x] 4.2 Attribute those events to the threaded `distinct_id` from Paddle `customData` when present, falling back to unresolved with the existing `identity_resolved` flag
- [x] 4.3 Capture purchase events in `src/app/api/license/webhook/route.ts`
- [x] 4.4 Capture cron outcomes for the routes listed in `vercel.json`
- [x] 4.5 Contract-test that a webhook still acknowledges normally when the analytics capture throws
- [x] 4.6 Capture an aggregate update-check count in `src/app/updates/latest.json/route.ts` — decided 2026-07-22. Counts only: no persistent per-install identifier may be introduced, assigned, or recorded, so nothing tracks an individual machine over time. The server already receives and logs these requests; this makes an existing signal visible rather than collecting anything new
- [x] 4.7 Contract-test that the updater capture carries no identifier — this is the seam where an aggregate count would quietly become install telemetry

## 5. Identity resolution

- [ ] 5.1 Call `identify` on successful claim redemption in `src/app/endstate/claim/[token]/ClaimClient.tsx`, using the identifier chosen in 1.1
- [ ] 5.2 Capture an identified activation event in `src/app/api/license/activate/route.ts`
- [ ] 5.3 Reset the analytics identity on sign-out so a later visitor on the same device is not attributed to the previous user
- [ ] 5.4 Confirm that a visitor's pre-signup anonymous events attribute to the resulting person after identify

## 6. Desktop handoff — observed on the web side only

The local product carries no telemetry. Nothing is threaded into it, and the observable journey ends here by design.

- [x] 6.1 Capture the handoff **on the web side** in `ClaimClient.tsx` — that the user activated "open in Endstate" is a website event about its own control
- [x] 6.2 Assert the `endstate://claim` link carries only what the claim functionally requires — no analytics identifier, session id, device id, or campaign parameter
- [x] 6.3 Add a contract test pinning that assertion, so no future change can quietly append one
- [x] 6.4 Confirm the copy-claim-code path is likewise captured web-side without altering what is copied

## 7. Product signal on the supported-apps page

- [x] 7.1 Capture debounced search events in `src/app/endstate/apps/AppsList.tsx` with query and result count, one event per settled search rather than per keystroke
- [x] 7.2 Capture the zero-result branch as a distinct event so unmet demand is directly queryable
- [x] 7.3 Verify no capture fires on the page's initial render

## 8. Session replay groundwork (gated — do not enable)

- [x] 8.1 Enumerate every surface rendering a recovery key, claim token, or account identifier
- [x] 8.2 Define masking rules covering those surfaces
- [x] 8.3 Add a contract test asserting replay stays disabled while masking is unverified
- [x] 8.4 Leave `disable_session_recording: true`; enabling it is a follow-up change

## 9. Verification

- [x] 9.1 `npm run lint`, `npm test`, `npm run build` all clean
- [x] 9.2 Confirm static generation is preserved for `/endstate`, `/blog`, and `/blog/[slug]`
- [x] 9.3 Confirm the privacy contract still holds: no event from any capture mechanism escapes on a private Exomem route
- [ ] 9.4 Exercise a full checkout in Paddle sandbox against a local production build and confirm intent, completion, and webhook events land on one person
- [ ] 9.5 Replay a webhook with analytics forced to fail and confirm Paddle still receives its acknowledgement
- [ ] 9.6 Check event volume against the PostHog plan before considering replay
