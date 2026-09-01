# Change: Move Endstate voluntary support to GitHub Sponsors

## Why

Voluntary support for Endstate ran through a Paddle checkout we operated: three
config-driven price IDs, a `transaction.completed` webhook on the legacy
`/api/license/webhook` compatibility URL, a durable supporter email outbox, a
thank-you template asking for recognition consent, and a cron drain behind all
of it. That is a payments integration, a webhook contract, and a mail queue —
built to move a one-time contribution that grants the contributor nothing.

GitHub Sponsors does the same job with none of it. The contributor is already
signed in to GitHub, the amount is a link, and the thank-you message GitHub
sends is where the recognition opt-in belongs. Nothing on our side has to
receive money, verify a signature, store a transaction, or send mail.

Two amounts (€10, €29) were never created in Paddle, so the tier grid has been
advertising configuration that does not exist. Moving the whole surface to
Sponsors settles that instead of finishing a payment setup we no longer want.

The Sponsors profile for the `substrate-systems` org is submitted but not yet
approved, so this change ships the destination state with the links switched off
behind one constant. Going live is a one-line follow-up.

## What Changes

- Voluntary support becomes one-time sponsorship on the GitHub Sponsors profile
  for the `substrate-systems` org, at $10 (Supporter), $29 (Founding Supporter),
  and $89 (Patron). Amounts are USD; the tier names and descriptions are
  unchanged. There is no recurring tier — a recurring obligation is exactly what
  the copy promises support does not create.
- `SPONSORS_LIVE` in `src/lib/support-tiers.ts` gates the links. While it is
  false the cards render in full and the button is replaced by one line saying
  support is moving, rather than pointing at an unapproved profile.
- The Paddle supporter purchase path is retired: `openSupportCheckout`, the
  `/api/license/webhook` route and its handler, the supporter thank-you email
  template, the supporter mail outbox drain in `db.ts`, and the cron pass that
  drove it. The three `NEXT_PUBLIC_PADDLE_PRICE_ID_*` support variables are no
  longer read.
- History is preserved: `supporter_contributions` and `supporter_email_outbox`
  and their migrations stay, the operator-only legacy Patron import stays, the
  `supporter` and `supporter_purchased` analytics identifiers stay locked, and
  the supporters page still renders `SUPPORTERS.md` from the engine repository.
- Recognition mechanics are restated for the new flow: the opt-in ask arrives
  with the GitHub Sponsors thank-you rather than a post-checkout email from us,
  and the listing is named as an acknowledgement rather than advertising or a
  purchased benefit.
- Endstate Cloud is untouched. Cloud billing, `/api/webhooks/paddle`, the Paddle
  SDK bootstrap, and the shared signature verification all stay exactly as they
  are.

## Supersedes

Three live changes still describe the Paddle supporter path in their own deltas:

- `reposition-endstate-cloud` — the config-driven tiers, the €89 env var, and the
  webhook price matching.
- `fix-hosted-backup-onboarding-delivery` — the `/api/license/webhook`
  destination remaining responsible for `transaction.completed` Supporter
  handling.
- `retire-endstate-lifetime-licensing` — scenarios that route Supporter
  `transaction.completed` handling to `/api/license/webhook`.

None is edited here — they are the record of what was decided then. This change
is the later decision on the same capability, so it must be synced or archived
after them, and the Paddle supporter destination in their text is retired by it.
Their Endstate Cloud requirements are unaffected. Tasks 7.1 to 7.4 name exactly
which of their requirements the first `endstate-project-support` spec sync must
drop.

## Non-goals

- No change to the Custom Project Sponsor mail path or to
  `/endstate/sponsor-an-integration`.
- No refund-policy change. Contributions remain refundable as Terms describes;
  only the processor changes.
- No new recurring sponsorship, no sponsor-only benefit, no entitlement.
