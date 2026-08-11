# Support Endstate — Paddle setup

How to make the €10 and €29 contribution amounts appear on
`/endstate/supporters#support`.

The support tiers are config-driven: `src/lib/support-tiers.ts` defines the
tiers, and each one renders **only** when its price ID is configured. Nothing
breaks while a price is missing — the tier simply is not shown, and the
"from €X" line on `/endstate` falls back to the lowest amount that is
configured. So the page ships today with only the €89 Patron tier and grows
without a code change once the prices below exist.

Do not create these through an API call from application code. Create them once,
by hand, in the Paddle dashboard.

## Brevo sender cutover (manual; do not automate)

1. Add and verify the intended sender domain and mailbox in Brevo, including
   the required DNS authentication records.
2. Send and inspect a sandbox test at the exact address before changing any
   production environment variable.
3. Set `BREVO_SENDER_EMAIL` only after that verification. `endstate@…` is
   supported, but is deliberately not a code default.
4. Set `BREVO_REPLY_TO_EMAIL=founder@substratesystems.io` (or another verified
   founder-operated mailbox), exercise a supporter outbox delivery and a
   retry, then check Brevo's delivery status.
5. Only after those checks, retire the legacy `licenses@…` sender. The runtime
   warns while it remains configured.

## 1. Create the prices in Paddle

Both amounts hang off the **existing** Endstate support product — the one that
already owns the €89 price behind `NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER`.
Adding prices to that product keeps every contribution in one place for
reporting and keeps the webhook logic simple.

For each amount:

1. Paddle dashboard → **Catalog → Products** → open the Endstate support product.
2. **Add price**.
3. Type: **One-time**. Not recurring — a contribution creates no subscription
   and no recurring obligation.
4. Amount: `10.00 EUR` for the first, `29.00 EUR` for the second.
5. Name it after the public tier: `Endstate Supporter (€10)` and
   `Endstate Founding Supporter (€29)`.
6. Tax category: match whatever the existing €89 price uses.
7. Save, then copy the resulting `pri_...` identifier.

Create the prices in **sandbox first**, verify with the steps below against
`NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox`, then repeat in production. Sandbox and
production price IDs differ.

## 2. Set the environment variables

| Variable                                         | Tier               | Amount                   |
| ------------------------------------------------ | ------------------ | ------------------------ |
| `NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_10`         | Supporter          | €10                      |
| `NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_29`         | Founding Supporter | €29                      |
| `NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER` | Patron             | €89 (already configured) |

Set them in the hosting environment for every environment that should offer the
tier. These are `NEXT_PUBLIC_*` values, so they are **inlined at build time** —
setting them does nothing until the next deploy.

`NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER` keeps its original name on
purpose; see [`docs/naming.md`](../naming.md).

## 3. Webhook

Nothing to change. `/api/license/webhook` matches an incoming
`transaction.completed` against **every** configured support price, so newly
configured amounts are accepted the moment they are set, and the original €89
price keeps working exactly as before. The handler stays recognition-only: it
notifies `founder@` so the name can be added to `SUPPORTERS.md` after the
contributor opts in, thanks the contributor, and issues no key and no
entitlement.

## 4. Verify after deploy

1. Open `/endstate/supporters#support` — the newly configured tiers appear as
   cards, alongside Patron and Custom Project Sponsor.
2. Open `/endstate` — the Support Endstate card's "from" amount now shows the
   lowest configured tier.
3. Click a new tier's button and confirm the Paddle overlay opens with the
   correct amount.
4. Complete a sandbox purchase and confirm two emails arrive: the founder
   notification and the contributor thank-you.

## Existing €89 supporter import (operator-confirmed; do not run casually)

The original €89 purchase remains a **Patron** contribution, with optional
administrative wording **Legacy Supporter / Patron**. It is not a licence,
entitlement, or request for a second payment.

1. In Paddle and the webhook archive, independently copy the original
   transaction ID, webhook event ID, and the event's original ISO-8601
   occurrence time. Do not infer any of them from an email address.
2. Preview the exact immutable record. This does not connect to a provider or
   write the database:

   ```powershell
   npm run import:legacy-patron -- --transaction-id=txn_… --event-id=evt_… --occurred-at=2026-08-01T12:00:00Z
   ```

3. Compare the preview with the receipt and archived webhook, then apply only
   with the deliberate matching confirmation:

   ```powershell
   npm run import:legacy-patron -- --transaction-id=txn_… --event-id=evt_… --occurred-at=2026-08-01T12:00:00Z --apply --confirm-transaction-id=txn_…
   ```

The import is idempotent on the real transaction and event identities. It
preserves the original timestamp, marks the historical thank-you and founder
notification as fulfilled to avoid duplicate mail, and leaves public
recognition pending explicit reply-based consent. Do not add a name to
`SUPPORTERS.md` unless the contributor expressly opts in.

## Custom Project Sponsor

There is nothing to configure. It is a `mailto:` link to `founder@` with a
prefilled body, deliberately not an arbitrary-amount checkout — a larger
contribution is a conversation, not a form field.
