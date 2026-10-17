## 1. Admission, waitlist and email outbox (migration 0063)

- [x] 1.1 Add migration 0063: email outbox table, `time_zone` on waitlist entries and tenants, `recipient_time_zone` on invitations, with its grants
- [x] 1.2 Add `cloudAdmissionHeadroom`, counting start links and operator invitations of every kind, and use it for start, promotion, redemption and invitation creation in place of the Hosted pool (implemented as `cloudAdmissionAllows` and `getCloudCapacityStatus`)
- [x] 1.3 Add Turnstile verification (action, hostname, 3 s timeout), failing closed only on Cloudflare's documented token errors and on a hostname or action mismatch, and falling back to the rate limits with a logged error for every other failure
- [x] 1.4 Add `POST /api/exomem/access/start` with `requestStart`, identical 202 answers and cookies, and a 600 ms floor
- [x] 1.5 Make the former sign-in link route an alias of the start handler
- [x] 1.6 Implement the `waitlist` (default) and `open` admission switch under the capacity advisory lock; the public form creates only paid self-serve start links
- [x] 1.7 Set start links to 48 hours and validate `timeZone` against the IANA set in start and both redeem routes
- [x] 1.8 Send a paid web redemption to the setup journey route
- [x] 1.9 Add the waitlist promotion arm to the reconcile job, oldest first, skipping addresses that own an active account, one transaction per admission
- [x] 1.10 Keep a waiting person's place and send no second waitlist email on a repeat request; resend a live start link with the same expiry, leaving earlier links valid and revoking siblings on redemption; send a lapsed or used start link to the back of the queue
- [x] 1.11 Anchor the unpaid hold and the hold reminder on the stopped cell's creation time
- [x] 1.12 Drain the outbox from the `exomem-access-delivery` cron, every minute, at most 20 rows a tick, retrying each row until its own expiry (a refused waitlist confirmation fails at once)
- [x] 1.13 Remove recipient and payload from settled outbox rows after 30 days and delete waitlist entries 180 days after the later of the last request and the last start link's expiry unless the address owns an account
- [x] 1.14 State the outbox and waitlist retention periods on the privacy page
- [x] 1.15 Test against PostgreSQL: no enumeration across outcomes, last place race, queue order, stale capacity, re-admission hold
- [x] 1.16 Run a dedicated security review of admission

## 2. Consent hand-back and owner apps

- [x] 2.1 Move the consent step rule into `src/lib` as the first commit
- [x] 2.2 Add `loadConsentView` with the already-connected flag, the loopback flag, the connector settings link and the code destination (redirect host or "this computer")
- [x] 2.3 Store a client name only when the client declares one, and show it beside the destination labelled as the client's own claim
- [x] 2.4 Add `POST /api/exomem/oauth/authorize/decline` with the shared origin check, nonce check and one-shot consume
- [x] 2.5 Add `authorizationDenialRedirect` bound to the consumed row's redirect URI
- [x] 2.6 Add `GET /api/exomem/apps` with display names and first-party exclusion
- [x] 2.7 Add `POST /api/exomem/apps/{id}/disconnect` that revokes grant, token families, access tokens and unconsumed codes
- [x] 2.8 Test against PostgreSQL: no grant or code written on decline, replay and expiry, foreign app id returns 404
- [x] 2.9 Run a dedicated security review of decline and disconnect

## 3. Account facts and reviewer sign-in (migration 0064)

- [x] 3.1 Add migration 0064: support reference with backfill, entitlement provider fields, grace start
- [x] 3.2 Write the provider fields from `subscription.*` events and from reconciliation, and reset them on re-admission
- [x] 3.3 Set the grace start only on a move into `past_due`, keep a stored or unknown value otherwise, and clear it on leaving `past_due`
- [x] 3.4 Export the kept-until rule as one function
- [x] 3.5 Add the `account` object to `GET /api/exomem/account` with known-or-reason dates
- [x] 3.6 Add the web path to the reviewer route with the same limits and one identical 401
- [x] 3.7 Test against PostgreSQL: grace start across repeated failures, unknown reasons, reviewer failures identical

## 4. Friend invitations and resubscribe (migration 0065)

- [x] 4.1 Add migration 0065: invitation kind, inviter and note fields, decision fields, friend offer on the tenant
- [x] 4.2 Add `POST /access/inspect` with the identical 404, the price preview cache and its rate limit
- [x] 4.3 Add `POST /api/exomem/invites/decision` with the Paddle update before consume
- [x] 4.4 Return `transactionId` from checkout and attach the friend discount on the server only
- [x] 4.5 Verify the friend discount's properties before each checkout and each subscription update, and fail closed on any difference
- [x] 4.6 Allow a new transaction for an ended owner's customer inside the kept window and let the kept cell resume
- [x] 4.7 Add inviter name, optional note and optional inviter email to the operator issue route and page
- [x] 4.8 Show free Cloud capacity on the operator page, block every invitation kind when none is free, and keep its paid default and covered confirmation
- [x] 4.9 Scrub the new personal data and outbox rows in deletion finish
- [x] 4.10 Test with the payment provider substituted: decision, failure, repeat, resubscribe, existing owner never signed in
  - Sandbox evidence, 2026-10-12. The substituted Paddle in these tests follows these sandbox answers:
    1. `GET /discounts` returns the field names that the discount verification checks.
    2. A pricing preview with `discount_id` and `customer_ip_address` returns `data.currency_code` "EUR", `details.line_items[].price.id`, `totals.total` as a string in minor units ("1000") and `line.discounts[].discount.id`. A US address still prices in EUR.
    3. `POST /transactions` with `customer_id` and `discount_id` but no `address_id` returns a "draft" transaction that echoes `discount_id` and has `checkout.url`. Paddle accepts a cancel of that transaction.
    4. `PATCH /subscriptions/{id}` with a discount accepts the request shape. Paddle refuses it with "discount is not valid for any items in subscription" when the subscription's price is not the price that the discount is restricted to. Task 4.12 keeps such owners to their plan before any Paddle call.
    5. The `subscription.created` event carries `transaction_id` and `custom_data`.
- [x] 4.11 Run a dedicated security review of the friend price
- [x] 4.12 Offer the friend price to an existing owner only when their live subscription holds the base price; another or an unreported price keeps the plan without a Paddle call
- [x] 4.13 Cancel an open resubscribe checkout at Paddle before a lapsed kept window deletes the cell, and keep the cell read-only while Paddle cannot answer
- [x] 4.14 Fix the independent review's findings: check the friend discount on every reopened checkout, read Paddle before storing `kept`, settle a lapsed checkout only on proof and within a time budget, recover a paid resubscription without its event, refuse checkout during deletion, scrub the inviter's note and copied name, date invitation emails in the reader's time zone, and share the invitation kinds and limits
- [x] 4.15 Cancel a bound resubscribe transaction or its subscription when deletion finishes, record the friend offer from a subscription event, budget the unpaid-hold expiry's Paddle calls, index invitations by redeemed tenant, and show the next payment amount from Paddle

## 5. Cell home channel, storage and export (migration 0066)

- [x] 5.1 Add migration 0066: first-party Home client with its admission mode, usage columns, export table, `export` hold kind, and grants
- [x] 5.2 Add `cloud-home-mcp` with the 120-second token mint and a closed set of server-selected calls (Home's two; the viewer's three)
- [x] 5.3 Add `GET` and `PUT /api/exomem/cloud/home/levels` with revision checks and the unavailable reasons
- [x] 5.4 Add `GET /api/exomem/cloud/home/live` for activity and note count
- [x] 5.5 Add storage to the status poll as known or unknown
- [x] 5.6 Add the export API: create, read, and link with the 8-second wait
- [x] 5.7 Reword the privacy page for a plain ZIP with provider encryption, kept up to the time limit
- [x] 5.8 Exomem repository: return `levels` from `configure_memory` through one precedence function
- [x] 5.9 Exomem repository: add ledger fields `access` and `item_count`, and the `activity` section of `bootstrap`
- [ ] 5.10 Exomem repository: add `cell-export` for a quiesced vault ZIP
- [ ] 5.11 Cell controller: record usage from backup and export reports
- [ ] 5.12 Cell controller: run the export (hold on every storage class, multipart upload, checks, ready, link, expiry, deletion)
- [x] 5.13 Send the authenticated client's name and context from the gateway to the cell (the measurement confirmed that Cloud ignored the chat apps level)
- [x] 5.14 Test with real PostgreSQL roles: tenant isolation, column grants, token scope, refusal after deletion
- [ ] 5.15 Rehearse on a local cluster with the real gateway: levels, activity, storage, export on running and stopped cells
- [ ] 5.16 Run a dedicated security review of the token mint, the export delivery path and the ledger fields
  - The 2026-10-16 review covers the token mint, the ledger fields and the web side of export. The cell controller's export delivery waits on PR #1708.

Tasks 5.10–5.12 and 5.15 wait on the cell export in the Exomem repository (PR #1708, not merged). Exports stay off until it ships, and tasks 6.5 and 10.3 follow it. The web side of export (tasks 5.6 and 8.8) is on main behind `EXOMEM_CLOUD_EXPORTS_ENABLED`.

## 6. Emails

- [x] 6.1 Add a renderer registry keyed by email kind with the existing renderers behind it
- [x] 6.2 Add the waitlist and place-opened kinds with the approved copy
- [x] 6.3 Route emails 01, 01w, 03 to 08 and 18 through the outbox with their dedupe keys and preconditions
- [x] 6.4 Route friend emails 09 to 13 through the outbox, including the invitee reminder and the two inviter notices
- [ ] 6.5 Enqueue the export-ready email once per export, linking to Home
- [x] 6.6 Render every time limit at send time in the recipient's time zone, UTC labelled when unknown
- [x] 6.7 Render emails 09 to 13 through the shared ten-slot template, with the R28 copy and bands, and remove their lint exemption
- [x] 6.8 Follow the device's colour scheme on the site until a theme is picked, and build each email on the scheme the person used the site in (migration 0072)
- [x] 6.9 Follow a change of the device's colour scheme while an Exomem page is open, and keep a picked theme

## 7. Frontend journey

- [x] 7.1 Build "Start with your email" with the Turnstile widget and the uniform "check your email" step
- [x] 7.2 Build the invitation steps: friend, covered, existing owner, unusable
- [x] 7.3 Build the consent steps with the code destination, the declined and kept hand-back (at most 3 s on screen for web apps) for web and loopback apps
- [x] 7.4 Build subscribe with Paddle inline checkout and backend-confirmed readiness
- [x] 7.5 Build the setup step with connection polling (3 s, then 30 s after 10 minutes) and the joined state
- [x] 7.6 Build the break states: connect error, ended, paused, suspended, expired, read-only
- [x] 7.7 Build reviewer sign-in on the web
- [x] 7.8 Check the approved phone placement and short-window scrolling in dark and light
- [x] 7.9 Block tasks 7.3 and 8.7 until the product owner approves deviations (h) and (i)

## 8. Frontend Home

- [x] 8.1 Build the status line, notices and connected apps with disconnect, showing the host beside a client-declared name labelled as the client's claim
- [x] 8.2 Build the levels rows over the levels API
- [x] 8.3 Build the live activity line with unavailable shown as nothing
- [x] 8.4 Build plan and account with known-or-reason dates and the support reference
- [x] 8.5 Build the storage bar over the real disk, and the unknown state
- [x] 8.6 Hide storage add-ons, email change, and bring-a-vault and restore until each ships
  - Storage add-ons now ship behind `EXOMEM_CLOUD_STORAGE_ENABLED`, off by default (#249). Email change and bring-a-vault or restore have no Home surface.
- [x] 8.7 Show the Cloud MCP address from configuration
- [x] 8.8 Build export with every display state, the pause sentence for a running or read-only cell, and the download link
- [x] 8.9 Keep deletion, and hide it for reviewers
- [x] 8.10 Build the reviewer Home
- [ ] 8.11 Inspect the result in the browser against the reference boards in both themes

## 9. Frontend landing

- [x] 9.1 Build the landing sections with "Start with your email" as the primary action
- [x] 9.2 Build the theme switch and the header sign-in
- [x] 9.3 Inspect the landing in the browser at desktop and phone widths

## 10. Release

- [x] 10.12 Prefill the authenticated owner email in setup, consent and Home transaction checkout without changing server-selected billing data
- [x] 10.13 Update public-subscription Terms with 18+ eligibility and accurate Turnstile/Brevo privacy disclosure
- [x] 10.14 Offer released Cloud plugin ZIPs and qualified installation guidance from Home, including when both providers are connected
- [x] 10.15 Clarify journey app tiles and origins, center expired requests, link the wordmark and bound optional checkout email acquisition

These corrections follow the launch polish merge because both batches change subscribe. Their production release follows independent review and acceptance.

- [x] 10.1 Deploy migrations 0063 to 0066 with every flag off
- [ ] 10.2 Release the exomem repository and roll cells out, owner canary first
- [ ] 10.3 Release the cell controller and turn the export flag on after the rollout, then redeploy, because the landing and privacy pages read the flag at build time
- [ ] 10.4 Release Home with levels and activity, then export after the rehearsal
- [ ] 10.5 Set `EXOMEM_PADDLE_DUNNING_DAYS` to match the provider's dunning settings
- [ ] 10.6 Turn `EXOMEM_SELF_SERVE_ADMISSION` to `waitlist`, then to `open`
- [x] 10.7 Confirm `enable-exomem-paid-alpha-invites` is archived with `--skip-specs`, because its proofs are tasks 10.9 and 10.10
- [ ] 10.8 Keep `route-connector-consent-by-account-state` open until its production walk passes, then archive it
- [x] 10.9 Run focused unit, route, PostgreSQL, webhook, security, static and browser checks for paid operator invitations
- [ ] 10.10 Prove one paid operator invitation in the Paddle sandbox from redemption to payment, then repeat as one controlled production invitation
- [ ] 10.11 Run strict OpenSpec validation and archive this change after the delivery

Production on 2026-10-16: migrations 0063 to 0066 are deployed. Admission is `waitlist`, and `open` is not set (task 10.6). The Home channel is off, and the cells still run Exomem 0.116, so tasks 10.2 and 10.4 wait on the cell rollout. `EXOMEM_PADDLE_DUNNING_DAYS` is 30; task 10.5 waits on a check of the payment provider's dunning setting. Tasks 10.8 and 10.10 wait on the first production friend invitation.

## 11. Design update rounds 41–47

This section tracks the approved integrated web batch. Earlier unchecked tasks remain programme records; they do not prove that existing code is absent. Viewer, add-ons and external status have separate capability and deployment boundaries. Their dependencies do not delay this batch.

- [x] 11.1 Prepare public-safe design references and served brand assets, preserving the original export separately
- [x] 11.2 Port the shared tokens, writing E, scoped motion engine and accessible transitions
- [x] 11.3 Build inline subscription checkout with transaction-bound events and server-confirmed readiness
- [x] 11.4 Add browser-bound resend recovery without changing authentication lifetime or account privacy
- [x] 11.5 Derive visible resend waits from the common server limiter and update invitation-only email copy
- [ ] 11.6 Apply the latest landing, start, connect and Home states over their actual data contracts
- [ ] 11.7 Complete the independent UI and accessibility pass against each enabled drawn state
- [ ] 11.8 Complete exact-content adversarial review, required checks, normal release and read-only production verification
- [ ] 11.9 Carry authenticated app identity through the gateway, cell activity feed and Home consumers; highlight the matching app for three seconds

Task 11.9 needs an additive backend field. Current activity events identify a client family; connected rows identify OAuth grants.
The UI cannot infer that join from a family or display name. Home activity remains disabled until its existing rollout acceptance.
Task 11.6 remains incomplete while this drawn behavior lacks its real data contract.

- [ ] 11.10 Deliver regional regular and friend catalogue selection, legacy compatibility and safe subscription conversion with provider acceptance
- [ ] 11.11 Record each app's last use at the gateway and show it on Home's app rows; close after the gateway image that records it runs in production

Tasks 11.1–11.5 have local implementation and browser evidence in PR #246.
The actual Sandbox subscription passed decline, retry, signed payment delivery and readiness polling.
These checks do not close independent review, release or production acceptance in task 11.8.
Tasks 11.6 and 11.9 retain the paired Source activity dependency; task 11.10 retains Live catalogue acceptance.
