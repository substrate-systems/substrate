## 1. Admission, waitlist and email outbox (migration 0063)

- [ ] 1.1 Add migration 0063: email outbox table, `time_zone` on waitlist entries and tenants, `recipient_time_zone` on invitations, with its grants
- [ ] 1.2 Add `cloudAdmissionHeadroom`, counting start links and operator invitations of every kind, and use it for start, promotion, redemption and invitation creation in place of the Hosted pool
- [ ] 1.3 Add Turnstile verification (action, hostname, 3 s timeout), failing closed only on Cloudflare's documented token errors and on a hostname or action mismatch, and falling back to the rate limits with a logged error for every other failure
- [ ] 1.4 Add `POST /api/exomem/access/start` with `requestStart`, identical 202 answers and cookies, and a 600 ms floor
- [ ] 1.5 Make the former sign-in link route an alias of the start handler
- [ ] 1.6 Implement the `waitlist` (default) and `open` admission switch under the capacity advisory lock; the public form creates only paid self-serve start links
- [ ] 1.7 Set start links to 48 hours and validate `timeZone` against the IANA set in start and both redeem routes
- [ ] 1.8 Send a paid web redemption to the setup journey route
- [ ] 1.9 Add the waitlist promotion arm to the reconcile job, oldest first, skipping addresses that own an active account, one transaction per admission
- [ ] 1.10 Keep a waiting person's place and send no second waitlist email on a repeat request; resend a live start link with the same expiry, leaving earlier links valid and revoking siblings on redemption; send a lapsed or used start link to the back of the queue
- [ ] 1.11 Anchor the unpaid hold and the hold reminder on the stopped cell's creation time
- [ ] 1.12 Drain the outbox from the `exomem-access-delivery` cron, every minute, at most 20 rows a tick, retrying each row until its own expiry
- [ ] 1.13 Remove recipient and payload from settled outbox rows after 30 days and delete waitlist entries 180 days after the later of the last request and the last start link's expiry unless the address owns an account
- [ ] 1.14 State the outbox and waitlist retention periods on the privacy page
- [ ] 1.15 Test against PostgreSQL: no enumeration across outcomes, last place race, queue order, stale capacity, re-admission hold
- [ ] 1.16 Run a dedicated security review of admission

## 2. Consent hand-back and owner apps

- [ ] 2.1 Move the consent step rule into `src/lib` as the first commit
- [ ] 2.2 Add `loadConsentView` with the already-connected flag, the loopback flag, the connector settings link and the code destination (redirect host or "this computer")
- [ ] 2.3 Store a client name only when the client declares one, and show it beside the destination labelled as the client's own claim
- [ ] 2.4 Add `POST /api/exomem/oauth/authorize/decline` with the shared origin check, nonce check and one-shot consume
- [ ] 2.5 Add `authorizationDenialRedirect` bound to the consumed row's redirect URI
- [ ] 2.6 Add `GET /api/exomem/apps` with display names and first-party exclusion
- [ ] 2.7 Add `POST /api/exomem/apps/{id}/disconnect` that revokes grant, token families, access tokens and unconsumed codes
- [ ] 2.8 Test against PostgreSQL: no grant or code written on decline, replay and expiry, foreign app id returns 404
- [ ] 2.9 Run a dedicated security review of decline and disconnect

## 3. Account facts and reviewer sign-in (migration 0064)

- [ ] 3.1 Add migration 0064: support reference with backfill, entitlement provider fields, grace start
- [ ] 3.2 Write the provider fields from `subscription.*` events and from reconciliation, and reset them on re-admission
- [ ] 3.3 Set the grace start only on a move into `past_due`, keep a stored or unknown value otherwise, and clear it on leaving `past_due`
- [ ] 3.4 Export the kept-until rule as one function
- [ ] 3.5 Add the `account` object to `GET /api/exomem/account` with known-or-reason dates
- [ ] 3.6 Add the web path to the reviewer route with the same limits and one identical 401
- [ ] 3.7 Test against PostgreSQL: grace start across repeated failures, unknown reasons, reviewer failures identical

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
- [ ] 4.11 Run a dedicated security review of the friend price
- [x] 4.12 Offer the friend price to an existing owner only when their live subscription holds the base price; another or an unreported price keeps the plan without a Paddle call
- [x] 4.13 Cancel an open resubscribe checkout at Paddle before a lapsed kept window deletes the cell, and keep the cell read-only while Paddle cannot answer
- [x] 4.14 Fix the independent review's findings: check the friend discount on every reopened checkout, read Paddle before storing `kept`, settle a lapsed checkout only on proof and within a time budget, recover a paid resubscription without its event, refuse checkout during deletion, scrub the inviter's note and copied name, date invitation emails in the reader's time zone, and share the invitation kinds and limits
- [x] 4.15 Cancel a bound resubscribe transaction or its subscription when deletion finishes, record the friend offer from a subscription event, budget the unpaid-hold expiry's Paddle calls, index invitations by redeemed tenant, and show the next payment amount from Paddle

## 5. Cell home channel, storage and export (migration 0066)

- [ ] 5.1 Add migration 0066: first-party Home client with its admission mode, usage columns, export table, `export` hold kind, and grants
- [ ] 5.2 Add `cloud-home-mcp` with the 120-second token mint and exactly two calls
- [ ] 5.3 Add `GET` and `PUT /api/exomem/cloud/home/levels` with revision checks and the unavailable reasons
- [ ] 5.4 Add `GET /api/exomem/cloud/home/live` for activity and note count
- [ ] 5.5 Add storage to the status poll as known or unknown
- [ ] 5.6 Add the export API: create, read, and link with the 8-second wait
- [ ] 5.7 Reword the privacy page for a plain ZIP with provider encryption, kept up to the time limit
- [ ] 5.8 Exomem repository: return `levels` from `configure_memory` through one precedence function
- [ ] 5.9 Exomem repository: add ledger fields `access` and `item_count`, and the `activity` section of `bootstrap`
- [ ] 5.10 Exomem repository: add `cell-export` for a quiesced vault ZIP
- [ ] 5.11 Cell controller: record usage from backup and export reports
- [ ] 5.12 Cell controller: run the export (hold on every storage class, multipart upload, checks, ready, link, expiry, deletion)
- [ ] 5.13 Send the authenticated client's name and context from the gateway to the cell (the measurement confirmed that Cloud ignored the chat apps level)
- [ ] 5.14 Test with real PostgreSQL roles: tenant isolation, column grants, token scope, refusal after deletion
- [ ] 5.15 Rehearse on a local cluster with the real gateway: levels, activity, storage, export on running and stopped cells
- [ ] 5.16 Run a dedicated security review of the token mint, the export delivery path and the ledger fields

## 6. Emails

- [ ] 6.1 Add a renderer registry keyed by email kind with the existing renderers behind it
- [ ] 6.2 Add the waitlist and place-opened kinds with the approved copy
- [ ] 6.3 Route emails 01, 01w, 03 to 08 and 18 through the outbox with their dedupe keys and preconditions
- [x] 6.4 Route friend emails 09 to 13 through the outbox, including the invitee reminder and the two inviter notices
- [ ] 6.5 Enqueue the export-ready email once per export, linking to Home
- [ ] 6.6 Render every time limit at send time in the recipient's time zone, UTC labelled when unknown
- [x] 6.7 Render emails 09 to 13 through the shared ten-slot template, with the R28 copy and bands, and remove their lint exemption

## 7. Frontend journey

- [ ] 7.1 Build "Start with your email" with the Turnstile widget and the uniform "check your email" step
- [ ] 7.2 Build the invitation steps: friend, covered, existing owner, unusable
- [ ] 7.3 Build the consent steps with the code destination, the declined and kept hand-back (at most 3 s on screen for web apps) for web and loopback apps
- [ ] 7.4 Build subscribe with the Paddle overlay and the confirming step
- [ ] 7.5 Build the setup step with connection polling (3 s, then 30 s after 10 minutes) and the joined state
- [ ] 7.6 Build the break states: connect error, ended, paused, suspended, expired, read-only
- [ ] 7.7 Build reviewer sign-in on the web
- [ ] 7.8 Check phone layouts fit one screen in dark and light
- [ ] 7.9 Block tasks 7.3 and 8.7 until the product owner approves deviations (h) and (i)

## 8. Frontend Home

- [ ] 8.1 Build the status line, notices and connected apps with disconnect, showing the host beside a client-declared name labelled as the client's claim
- [ ] 8.2 Build the levels rows over the levels API
- [ ] 8.3 Build the live activity line with unavailable shown as nothing
- [ ] 8.4 Build plan and account with known-or-reason dates and the support reference
- [ ] 8.5 Build the storage bar over the real disk, and the unknown state
- [ ] 8.6 Hide storage add-ons, email change, and bring-a-vault and restore until each ships
- [ ] 8.7 Show the Cloud MCP address from configuration
- [ ] 8.8 Build export with every display state, the pause sentence for a running or read-only cell, and the download link
- [ ] 8.9 Keep deletion, and hide it for reviewers
- [ ] 8.10 Build the reviewer Home
- [ ] 8.11 Inspect the result in the browser against the reference boards in both themes

## 9. Frontend landing

- [ ] 9.1 Build the landing sections with "Start with your email" as the primary action
- [ ] 9.2 Build the theme switch and the header sign-in
- [ ] 9.3 Inspect the landing in the browser at desktop and phone widths

## 10. Release

- [x] 10.12 Prefill the authenticated owner email in setup, consent and Home transaction checkout without changing server-selected billing data
- [x] 10.13 Update public-subscription Terms with 18+ eligibility and accurate Turnstile/Brevo privacy disclosure
- [x] 10.14 Offer released Cloud plugin ZIPs and qualified installation guidance from Home, including when both providers are connected

These corrections follow the launch polish merge because both batches change subscribe. Their production release follows independent review and acceptance.

- [ ] 10.1 Deploy migrations 0063 to 0066 with every flag off
- [ ] 10.2 Release the exomem repository and roll cells out, owner canary first
- [ ] 10.3 Release the cell controller and turn the export flag on after the rollout, then redeploy, because the landing and privacy pages read the flag at build time
- [ ] 10.4 Release Home with levels and activity, then export after the rehearsal
- [ ] 10.5 Set `EXOMEM_PADDLE_DUNNING_DAYS` to match the provider's dunning settings
- [ ] 10.6 Turn `EXOMEM_SELF_SERVE_ADMISSION` to `waitlist`, then to `open`
- [ ] 10.7 Confirm `enable-exomem-paid-alpha-invites` is archived with `--skip-specs`, because its proofs are tasks 10.9 and 10.10
- [ ] 10.8 Keep `route-connector-consent-by-account-state` open until its production walk passes, then archive it
- [ ] 10.9 Run focused unit, route, PostgreSQL, webhook, security, static and browser checks for paid operator invitations
- [ ] 10.10 Prove one paid operator invitation in the Paddle sandbox from redemption to payment, then repeat as one controlled production invitation
- [ ] 10.11 Run strict OpenSpec validation and archive this change after the delivery
