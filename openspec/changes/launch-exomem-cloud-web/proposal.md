## Why

Exomem Cloud launches with the web experience in `docs/exomem-design`: a landing page, a start-with-your-email journey, consent, and a Home that controls the account. Checked against the code, the boards ask for behaviour the system lacks or gets wrong:

- A new person cannot start. Self-serve admission is closed, the old request path leaked account existence through inline mail and one error branch, and capacity still counts the retired Hosted pool.
- "Not now" on the consent page has no route. An app that opened consent never learns the answer.
- Owners cannot list or disconnect their apps. Reviewers cannot sign in on the web.
- Home hard-codes the plan name, has no next-payment date, no read-only end date and no support reference.
- Friend prices do not exist. An owner whose subscription ended cannot resubscribe: checkout refuses a known customer and re-admission refuses a kept cell.
- The unpaid seven-day hold runs from the tenant's creation, so a re-admitted person expires on the next sweep.
- Export means "ask support". Home cannot read or set levels, show activity, or measure storage; it assumes a fixed 5 GiB.

## What Changes

- Admission: a start form behind Cloudflare Turnstile, a capacity waitlist with first-come promotion, and an email outbox that sends every mail once. Every start request gets the same answer.
- Consent: "Not now" and "Keep it as it is" hand `access_denied` back to the app. Owners list and disconnect apps. Reviewers sign in on the web.
- Account facts: plan name, next payment, read-only and kept-until dates, reviewer end date and a support reference, all from stored data.
- Friends: operator-issued friend, covered and standard invitations; one server-applied Paddle discount; resubscribe inside the kept window.
- Home to cell: a server-side channel that reads and sets levels and reads activity, a storage observation, and a self-serve ZIP export that expires.
- Frontend: the journey, Home and landing, built as drawn, with the six departures listed in `design.md`.
- **BREAKING** The unpaid hold anchors on the stopped cell's creation. Start links last 48 hours.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-hosted-access`: start form, waitlist, outbox emails, consent outcomes, apps, reviewer web sign-in, friend invitations.
- `exomem-tenant-control-plane`: Cloud capacity, the unpaid hold, export rows, the Home token, storage observation.
- `exomem-hosted-entitlements`: friend price, stored subscription facts, self-serve and resubscribe checkout.
- `exomem-home`: self-serve export, levels, activity, storage, plan and dates, support reference, connection polling.

## Impact

- Substrate migrations 0063 to 0066 (admission and outbox, account data, friend invitations, cloud home and exports). Migration 0062 belongs to `admit-generic-mcp-clients`.
- Substrate routes under `/api/exomem/{access,oauth,apps,account,invites,billing,cloud}`, the cron routes, and `src/app/exomem` pages and components.
- The exomem repository (runtime, cell export, cellctl) for levels, activity, storage and export. Its own spec deltas travel with that repository.
- The gateway changes only if a measurement confirms a client-name bug (see `design.md`).
- Related changes stay open: `enable-exomem-paid-alpha-invites` and `route-connector-consent-by-account-state` keep unticked production proofs; `admit-generic-mcp-clients` supplies stored client names.
