## Context

Exomem Cloud opens to the public with a web experience drawn in `docs/exomem-design`. The boards win for visuals and copy. That folder's README wins for rules. The code decides what the backend can do. This change records the decisions that close the gaps between them.

The work runs as separate lanes against shared files. Migration numbers are reserved: 0062 belongs to `admit-generic-mcp-clients`; 0063 to admission, the email outbox and time zones; 0064 to account data; 0065 to friend invitations; 0066 to the Home channel and exports. A lane that needs none leaves its number unused.

## Goals / Non-Goals

Goals:

- Let a new person start with an email, wait for a place, or use an invitation, without leaking whether an address has an account.
- Let an app that opened consent hear "no" and get the browser back.
- Show every Home value from stored data, in the reader's time zone, with unknown as a visible state.
- Give Home the same levels the assistant sees, a content-free activity line, real storage use and a self-serve export.

Non-goals:

- Storage add-ons, email change, vault import and the graph viewer. The launch cut defers them.
- A generic proxy from the web to the cell.
- A second specification tree. The deltas in this change are the durable contract.

## Decisions

### Admission, Turnstile, waitlist and outbox

One public route, `POST /api/exomem/access/start`, takes `{email, turnstileToken, timeZone?}`. The old sign-in link route becomes an alias of the same handler. Reason: no caller can skip the challenge.

The order is fixed: Turnstile check (action `start`, the public host, 3 seconds), then two rate limits (per network 20 an hour, per address 5 an hour), then the branch, then padding. Only a token error that Cloudflare documents (`missing-input-response`, `invalid-input-response`, `timeout-or-duplicate`), or a hostname or action mismatch, fails with 400 `challenge_failed`. Every other case, including a malformed address, a rate limit, an existing owner and a full Cloud, returns 202 with the same body and byte-identical `Set-Cookie`. Everything after the challenge takes at least 600 ms. A content-free metric records an overrun. Every other failure means the check cannot run: a 408, 429 or 5xx answer, a transport error, `internal-error`, a missing or rejected secret, or a test secret in production. The request then continues under the rate limits and the server logs an error. Reason: the cost of refusing every person during an outage exceeds what a bot gets past the rate limits, and the error log makes a broken secret visible. A verdict that the token failed is different: it says something is wrong with the request, so it fails closed.

The branch for a new address follows `EXOMEM_SELF_SERVE_ADMISSION`: `closed` (default) sends nothing; `waitlist` queues everyone; `open` admits when a place is free and nobody waits, and queues otherwise. Admission, promotion and queueing run under one advisory lock. Free capacity is fresh Cloud slots minus live cells minus outstanding invitations, where one person's start links count as one place, which are unexpired start links and operator invitations of every kind, complimentary, covered and reviewer invitations included. It replaces the retired Hosted pool for start, promotion, redemption and invitation creation. Reason: a free invitation takes a place as much as a paid one. Stale observations admit nobody.

Only an operator creates complimentary, covered, friend and paid operator invitations. The public start form creates only paid self-serve start links. Reason: a public form that can mint free access is a hole in the money path.

Promotion is a separate arm of the reconcile job. Each admission is its own transaction and takes the oldest waiting entry with `FOR UPDATE SKIP LOCKED`, and skips an address that already owns an active account. A person who asks again while waiting keeps their place and gets no second waitlist email, because the approved copy promises that we write again only when a place opens. Only a person whose start link lapsed or was used (and whose tenant was later deleted) joins the back. Reason: if every request moved a waiting person back, anyone who knows an address could push that person to the back of the queue. A person with a live start link who asks again gets a fresh link with the same expiry, so asking again never extends a place. The earlier unconsumed links stay valid until they expire, and redeeming one revokes its siblings. Reason: a person who asks again because the first email was late must not lose the first link. The system never reveals a queue position, because a position confirms that an address waits.

Every email goes through one outbox table with a unique dedupe key. The row is enqueued in the transaction that records the fact. A cron drains at most 20 rows a minute at least once, under a lease, and a row retries until its own expiry, so a provider outage costs nobody a place. Each kind re-checks its precondition when claimed and cancels if it no longer holds. The kinds are a closed set fixed in code, one template each. Time limits render at send time in the recipient's time zone or labelled UTC. Reason for the outbox: inline mail leaked state through timing and through one 503 branch, and it could not guarantee "sent once".

Settled outbox rows lose their recipient and payload after 30 days. A waitlist entry is deleted 180 days after the later of the person's last request and the expiry of its last start link, unless the address owns an account, so admitted entries whose link lapsed age out too. Deleting an account scrubs its outbox rows. The privacy page states these periods. Reason: the outbox holds addresses and token payloads that nothing needs once an email settles.

Start links last 48 hours, not seven days. This design calls the link that a start request creates a "start link". The unpaid hold anchors on the stopped cell's creation. Re-admission never reset the tenant's creation time, so a returning person expired on the next sweep.

The time zone is optional input checked against the closed IANA set. An unknown name becomes unknown, not an error.

### Consent outcomes and owner apps

"Not now" and "Keep it as it is" call `POST /api/exomem/oauth/authorize/decline` with `{confirmation, nonce, outcome}`. The OAuth continuation cookie is the authority, so no session is needed. One update consumes the transaction and binds `redirect_uri`. The redirect is built only from that row plus `error=access_denied` and `state`. Neither outcome writes or revokes a grant or code; `outcome` labels a content-free event. This is the same hand-back a finished connection performs, so the app never hangs.

A web app gets the declined or kept page for at most 3 seconds, then a top-level navigation. A loopback app is told in the background and the page stays. Chrome's Local Network Access may block a public page's request to loopback, so the page probes and falls back to a navigation. "Connect after all" becomes a link to the app's connector settings for a web app, taken from configuration keyed by platform because vendors move those pages. When no link is configured for the platform, there is no action. It is dropped for a loopback app, because the transaction is already consumed.

The consent view loads on the server (`loadConsentView`). It reports whether the app is already connected, from a live grant on the unique key. The page always shows where the code goes: the redirect host, or "this computer" for a loopback redirect. A name that the client declared appears next to that destination, labelled as the client's own claim. Reason: a generic client can declare any name, so the destination is the only fact the person can trust. The system stores a client name only when the client declares one. It shares the consent step rule with Home, which moves into `src/lib` first.

`GET /api/exomem/apps` lists the owner's apps with the name the client declared, else the platform label, else the host. First-party clients are excluded by a column. `POST /api/exomem/apps/{id}/disconnect` revokes the grant, token families, access tokens and unconsumed codes, limited to the session's user and tenant. The waiting step of the journey polls the list every 3 seconds for 10 minutes and moves to "joined" when an app's last-authorized time passes the first poll's server time. A reconnect bumps that time, so reconnecting counts. After 10 minutes the step keeps waiting and polls every 30 seconds. It adds no new element, so a person who connects late still sees "joined".

### Reviewers on the web

A body without `nonce` takes a new web path on the reviewer route. It reuses the credential check, rate limits and constant-work password hash, then creates a web session. Every failure returns the existing 401. A body with a nonce keeps the app path.

### Account facts

`GET /api/exomem/account` adds an `account` object beside the unchanged `billing`. Every date is `{value, reason}`: a value, or null with a reason. The plan name is the stored Paddle price name; the hard-coded "private alpha" goes. The next payment is the stored next billing time; null reasons are `complimentary`, `no_subscription`, `not_reported`, `ended` and `paused`. The read-only end is the grace start plus `EXOMEM_PADDLE_DUNNING_DAYS`; unset gives `dunning_window_unconfigured`. The kept-until rule from the lifecycle module becomes one exported function. The friend price shows as applied only when the provider-reported discount equals the configured one. A reviewer sees the credential's end date.

Each tenant gets a unique support reference of 4 random Crockford characters, shown as `EX-XXXX`, backfilled and then required. Subscription events and reconciliation store price id and name, next billing time, discount id, scheduled change and grace start. Only `subscription.*` events write them. The grace start is set only when the state moves into `past_due`. While it stays `past_due`, the stored value stays, and an unknown value stays unknown. No date is guessed from an update time. Home shows the read-only end as unknown with the reason `grace_start_unknown` in that case.

A paying owner who opens a covered or standard invitation keeps their plan with no automatic switch.

### Friend invitations, the friend price and resubscribe

An operator issues `standard`, `friend` or `covered` invitations. A friend invitation carries the inviter's name, and optionally a note and an email; a covered invitation is complimentary (a check ties kind to entitlement source). `POST /access/inspect` takes the bearer token and returns the facts, or one identical 404 for any unusable token. Prices come from the Paddle pricing preview for the caller's country, cached for 10 minutes; a failure is `price_unavailable`, never a guess. An existing owner presenting a token never gets a session. The inspect response may say that the owner exists. That is the one place the system reveals an account, and only the holder of a valid token can read it.

`POST /api/exomem/invites/decision` lets a signed-in owner pick `use_friend_price` or `keep_plan`. The Paddle update runs first and the invitation is consumed after, so a Paddle failure leaves it usable.

The friend price is one recurring Paddle discount per environment, with no code, not enabled for checkout and restricted to the Exomem price. The server attaches it; clients cannot. Before each use, at checkout and at the subscription update behind the decision route, the server checks those properties and fails closed on any difference. Reason: a discount that anyone can type is a coupon leak, and a wrong discount costs money on every renewal.

Resubscribe: checkout refuses any owner with a Paddle customer, and re-admission refuses a live cell, so "Resubscribe" on an ended account cannot work today. The fix allows a new transaction for the same customer within the kept window and lets the kept data resume. Invitees get timers through the outbox: a reminder three days before expiry and two inviter notices.

### The Home to cell channel

Two facts live in two places, so two channels carry them.

Live process facts (levels, activity, note count) come from the cell's existing `/mcp` through the public gateway. The web server mints a 120-second access token for a first-party Home client for each call, bound to the session's tenant. The module exposes exactly two calls: `configure_memory` and `bootstrap` with the `activity` section. It is not a proxy. The token stays in memory and never reaches a log or a browser. The Home client has its own admission mode, `first_party`. The authorization, code exchange and refresh paths of this release and the one before it admit a client by a pinned or generic mode or by admitted CIMD metadata. The Home client has neither, and no supported writer in either version gives it CIMD metadata, so neither version can authorize it interactively. Only the gateway's token lookup admits the mode, and that lookup already re-checks revocation, account blocks and deletion. Home's server calls for every owner from a few shared addresses, so the gateway skips its per-address limit for a token that its lookup resolved to this client; the per-tenant limit still applies. So the gateway ships before Home traffic is enabled.

Volume and object-store facts (storage, export) come from rows that the cell controller writes and Substrate reads, the same split as imports. The cell controller has no connection to a cell, and cells have no egress.

The cell registers only `/mcp` and health, and custom routes would skip authentication. So nothing new is registered; the channel adds output fields only.

### Levels and activity

Home writes the same preference file the assistant uses. The cell verifier resolves the Home token to the owner audience, which keys the preference. The cell returns the resolved level and its source for each context, from one precedence function. A write carries the revision read; a stale one returns 409 with the current state. A read-only cell refuses writes. An operator override is shown and not overwritten.

The activity section returns at most 20 content-free events: client family, action, item count and time. Events merge when the same client repeats an action within 60 seconds. Item counts come from the released-path outcomes of the disclosure collector, not from content. The action comes from command metadata, not a tool-name list. The ledger lives in an emptyDir, so a restart empties it and moves the start time forward. An older image refuses the unknown section, and Home shows "outdated" as unavailable. Home reads on load, on tab focus and every 30 seconds while visible. Unavailable shows nothing, never zero.

A measurement confirmed one bug: the remote HTTP surface is stateless and the gateway forwards no client name, so every handshake-protocol call resolved to the coding context, and chat apps got Balanced instead of Maximal. The gateway now sets two headers from the token's stored client. `x-exomem-oauth-client` carries the display name that the app list shows; the cell uses it after `clientInfo`. `x-exomem-client-context` carries `coding` when every registered redirect URI is loopback, otherwise `conversation`; the cell honours it before name detection. The context reads the client's registered redirect URIs, because a grant keeps no redirect after its authorization transaction is pruned. The app list reports the same context for each app, so the journey saves a chosen level to it. A caller's copy of either header is refused, and the gateway replaces any copy that passes the check.

### Storage

The cell controller records used bytes, filesystem bytes and the observation time from every backup and export job. The status poll stays database-only and reports `known` with values, or `unknown`. Home shows the real disk. The legacy 5 GiB constant goes. Freshness today is the nightly backup.

### Export

An export is a plain ZIP of Markdown files and attachments. It sits at the Cloud object store under the cell's prefix with provider encryption, for `EXOMEM_EXPORT_TTL_HOURS` (default 24), then the cell controller deletes every version. The download link exists only through Home, lasts 5 minutes, and names one object version. The email links to Home, never to the archive. The privacy page says exactly this. Reason for plain over end-to-end encrypted: an owner can open the archive without tooling, and the product owner chose it.

State lives in `exomem_cloud_exports` with split column authority. Substrate writes `requested_state` and `link_requested_at`; the cell controller writes everything it observes. One open export per cell. The display state comes from one function: none, packing, ready, expired, failed. The cell controller takes an `export` hold, which stops the cell for the job. The hold stops the cell on every storage class, because there is no clone path. A stopped cell stays stopped, and its runtime never starts. Part uploads are checked by count and ETag digest before completion. The API caps requests at three in 24 hours.

Until local storage ships, an export stops a cell that serves assistants for a few minutes. The export row says so, in its description and in its packing line, whenever the export will stop a running or read-only cell. The rule keys on that mechanism and does not promise the pause itself. A stopped cell gets no such sentence.

## Deviations from the design handoff

This is the single list of places the build departs from the boards. Each is deliberate and has a reason.

| | Departure | Reason | Approval |
| --- | --- | --- | --- |
| (a) | For a web app, "Not now" and "Keep it as it is" navigate to the app after showing the declined or kept state for at most 3 seconds. For a loopback app the app is told in the background and the page stays. | The board's page stays. A web app cannot be told in the background, so the browser must carry the denial back to it. | Approved |
| (b) | A Turnstile one-click check appears under the email field when Cloudflare suspects a bot. | The boards have no third-party element. The check is part of the approved admission decision. | Approved |
| (c) | The waitlist email and the place-opened email. | The catalogue has no copy for a waitlist. The new copy follows the template and the writing rules. | Approved 2026-10-12 |
| (d) | The export row says that assistants pause for a few minutes, when the export stops a running or read-only cell. | Until local storage ships, such an export stops the cell. The owner must know before starting. | Approved 2026-10-12 |
| (e) | The storage bar shows the real disk, not "2 of 5 GB". | The board's number is a legacy constant that does not describe the volume. | Approved |
| (f) | "Connect after all" becomes a link to the app's connector settings for a web app, and disappears for a terminal app. | The OAuth transaction is already consumed, so the button cannot resume it. | Approved, with (a) |
| (g) | Home hides the storage add-ons, email change, and bring-a-vault and restore controls until each ships. | The launch cut defers them, and a control with no working route would be a dead button. Each is being built now and gets its own OpenSpec change. | Approved |
| (h) | The address that Home and setup show is the Cloud MCP URL from configuration, not the handoff's retired Hosted path. | The code's real capability wins (README rule on code against pictures). The Hosted path no longer reaches a cell. | Engineering decision; owner confirmation pending |
| (i) | The consent page and the Home apps list show where the code goes (the redirect host, or "this computer"), and a client-declared name next to it, labelled as the client's own claim. | A generic client can declare any name. The person must see the real destination. | Engineering decision from the security review; owner confirmation pending, and the label copy is not yet approved |

### Approved new copy

The product owner approved this copy on 2026-10-12. The build uses it word for word. Times compute at send time in the recipient's time zone.

Waitlist email (kind `waitlist`), sender "Exomem <exomem@substratesystems.io>", band *arrive*, no note or facts, no action:

- Subject: "You're on the Exomem waitlist"
- Preheader: "We'll email you when a place opens."
- Headline: "You're on the list"
- Body: "Exomem is full for now. We add room as we grow. When a place opens for you, we'll send a link to start."
- Small print: "You don't need to do anything. If you didn't ask for this, ignore this email. We write again only when a place opens."
- Footer: "Exomem by Substrate Systems"

Place-opened email (kind `place-opened`), same sender, band *arrive*:

- Subject: "Your place in Exomem is ready"
- Preheader: "Start before {expiry: d MMM, HH:mm} to keep it."
- Headline: "Your place is ready"
- Body: "A place opened up for you. Start your Exomem, then add it to your assistant."
- Action: "Start Exomem", linking to the start link
- Small print: "The link works once, until {expiry: d MMM, HH:mm} (your time). If you don't use it, the place goes to the next person on the list."
- Footer: "Exomem by Substrate Systems"

Home export row, when the export will stop a cell that serves assistants (a running or read-only cell):

- Description when no export exists: "All your notes and files, as Markdown. Works in every state. Your assistants pause for a few minutes while we pack it."
- Packing line: "Packing your notes and files… Your assistants are back in a few minutes. We'll email you when it's ready."

For a stopped cell, the row keeps the board copy: "All your notes and files, as Markdown. Works in every state." and "Packing your notes and files… We'll email you when it's ready."

## Release order

1. Substrate migrations and grants first, with every flag off. They are additive.
2. Exomem release and cell rollout, owner canary first. The new fields are additive and the ledger reads both versions.
3. The cell controller. An export on an old cell image fails harmlessly as `EXPORT_FAILED`. Turn the flag on only after the rollout.
4. The gateway client headers, after the cell image that reads them. An older cell ignores headers it does not know.
5. Substrate Home: levels and activity first, export after a rehearsal on a local cluster with a real gateway and an object-store stand-in.
6. Admission last. Turn `EXOMEM_SELF_SERVE_ADMISSION` from `closed` to `waitlist`, then to `open`.

Rollback turns the flags off. Export rows stay, and the cell controller still expires objects.

## Risks / Trade-offs

- Enumeration. Inline mail, a single 503 branch and a queue position leaked state before. The outbox, padding, identical cookies and a hidden position remove those. A bot that bypasses Turnstile still meets the rate limits.
- Open redirect. The decline redirect comes only from the consumed row. A wrong rule here sends a person to an attacker's address.
- Invitation token. It is a 30-day bearer credential, stored encrypted for the reminder and never signing in an existing account.
- Waitlist fairness. A bug that lets newcomers pass the queue is a visible failure. Both paths take the same lock.
- Discount abuse. No code, not enabled for checkout, price-restricted, verified before use. The operator should audit live codes once.
- Plaintext export. The archive is readable by the storage provider for at most the TTL. Provider encryption, verified deletion and the reworded privacy page cover it.
- Availability. An export stops a running cell for its duration on every storage class. All Vercel traffic shares the gateway's per-address limit of 120 a minute.
- Stale capacity. Stale capacity observations admit nobody. If the observer stops, every new address waits, and the failure is visible as a waitlist that does not move. Alert on the age of the newest observation.
- Generic MCP clients. Do not enable the generic-client lane from `admit-generic-mcp-clients` before `reclaim-oauth-client-slots` covers its client partition. The partition bound only counts up until then.
- Related changes. This change archives `enable-exomem-paid-alpha-invites` with `--skip-specs`, before this change. This change restates what is still true in it. Paid operator invitations count against Cloud capacity ("Operator creates a paid invitation" and "Invitation delivery fails or expires"). A paid redemption admits a stopped cell that starts after payment, which the code confirms. Home keeps its awaiting-payment state. The operator page keeps its in-memory bearer and its paid default. This change drops the rest, because it would write false text: its tenant-control-plane edit targets a requirement that no longer exists, its redemption text says a paid redemption creates no cell, its catalog edit removes a requirement that the main spec still states correctly, and its provisioning-operation text belongs to the retired Hosted platform. Its two unticked proofs (verification and a sandbox and production invitation) move to the release tasks here. `route-connector-consent-by-account-state` stays open. It only adds one requirement, and only its production walk remains.
- Debt noted, not fixed here. The kept-until value moves with later applied events.
- Dedicated security review: admission, decline and disconnect, the friend price, and the Home token mint.
