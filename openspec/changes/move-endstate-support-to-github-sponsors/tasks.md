# Tasks

## 1. Tier definitions

- [x] 1.1 Replace the Paddle price lookups in `src/lib/support-tiers.ts` with
      static one-time GitHub Sponsors URLs for $10, $29, and $89, keeping the
      existing tier names and descriptions verbatim
- [x] 1.2 Add `SPONSORS_LIVE`, the single constant that gates the links
- [x] 1.3 Replace `lowestConfiguredSupportAmount()` with `lowestSupportAmount()`,
      now that no amount depends on configuration

## 2. Contribution surface

- [x] 2.1 `SupportTiers.tsx`: drop `usePaddle`/`BuyButton`; render each tier as a
      plain outbound link (`target="_blank" rel="noopener"`) when live, and one
      quiet line when not
- [x] 2.2 Keep the Custom Project Sponsor card exactly as it is
- [x] 2.3 `supporters/page.tsx`: restate the recognition mechanics for the
      Sponsors thank-you and name the listing as an acknowledgement, not
      advertising — heading and voluntary-support paragraph unchanged
- [x] 2.4 `endstate/page.tsx`: the Support Endstate card reads "from $10"

## 3. Retire the Paddle supporter purchase path

- [x] 3.1 Remove `openSupportCheckout` and the `supporter` member of
      `CheckoutProduct` from `src/lib/paddle.ts`, leaving the Cloud checkout and
      the SDK bootstrap untouched
- [x] 3.2 Delete `src/app/api/license/webhook/` and its tests
- [x] 3.3 Delete `src/lib/email-templates/supporter.ts` and its test
- [x] 3.4 Remove the supporter contribution writer and mail outbox drain from
      `src/lib/hosted-backup/db.ts`, keeping the legacy Patron import
- [x] 3.5 Remove the supporter drain pass and its response fields from
      `src/app/api/cron/claim-followups/route.ts`, leaving claim resends,
      founder alerts, and cancellation tombstones alone
- [x] 3.6 Leave `supporter_contributions`, `supporter_email_outbox`, their
      migrations, and the `supporter` / `supporter_purchased` analytics
      identifiers in place

## 4. Tests

- [x] 4.1 Rewrite the commercial-pages contract to the Sponsors link contract and
      pin the interim state, the tier amounts, and the recognition copy
- [x] 4.2 Rewrite the retirement contract to pin that support-tiers carries no
      Paddle reference and that the retired files are gone
- [x] 4.3 Prune the supporter cases from the outbox and cron suites, pinning the
      retired exports and the cron response instead

## 5. Documentation

- [x] 5.1 `docs/naming.md`: mark the three Paddle support price variables retired
      and the webhook route removed; keep the analytics identifiers locked
- [x] 5.2 Mark `docs/runbooks/support-endstate-paddle-setup.md` superseded
- [x] 5.3 Refresh `public/llms.txt` and `public/llms-full.txt` to the GitHub
      Sponsors amounts in USD
- [x] 5.4 Terms: name GitHub Sponsors as the processor for contributions and the
      listing as an acknowledgement

## 6. Before merge

- [ ] 6.1 Deactivate the `/api/license/webhook` notification destination in the
      Paddle dashboard, so the route's deletion cannot strand deliveries. This
      does not depend on GitHub approving anything

## 7. First spec sync (whenever the main spec is first written)

Three live changes still describe the Paddle supporter path; merging their deltas
wholesale produces an `endstate-project-support` spec that contradicts itself.
Drop the requirements named below rather than merging them. Where any of them
disagrees with this change's delta, this change's delta wins.

- [ ] 7.1 From `reposition-endstate-cloud/specs/endstate-project-support/spec.md`,
      drop three requirements in full: "Contribution amounts are config-driven
      and degrade gracefully" (env-gated Paddle prices), "The webhook accepts
      every configured support price" (the retired route), and "Supporter email
      obligations remain observable until delivered" (the retired outbox drain)
- [ ] 7.2 From the same file, keep "Voluntary project support is named Support
      Endstate", "Custom Project Sponsor routes to the existing contact path",
      "Supporter recognition stays opt-in and sourced from the engine
      repository", "The first €89 contribution is preserved as Patron", and
      "Contributor recognition consent is requested by email" — but delete the
      `/api/license/webhook` scenario under "Supporting Endstate grants nothing",
      and prefer this change's wording wherever the two restate each other
- [ ] 7.3 From
      `fix-hosted-backup-onboarding-delivery/specs/hosted-backup-subscriptions/spec.md`,
      in "Dedicated Hosted Backup notification destination", delete the paragraph
      requiring `/api/license/webhook` to remain responsible for
      `transaction.completed` Supporter handling; keep the rest, which is
      Endstate Cloud's own destination
- [ ] 7.4 From
      `retire-endstate-lifetime-licensing/specs/endstate-paid-tiers/spec.md`,
      delete the scenarios routing Supporter `transaction.completed` handling to
      `/api/license/webhook`; keep the lifetime-licence retirement itself

## 8. Go-live (after GitHub approves the profile)

- [ ] 8.1 Confirm the three one-time amounts exist on the `substrate-systems`
      Sponsors profile and that the thank-you message carries the recognition
      opt-in ask
- [ ] 8.2 Flip `SPONSORS_LIVE` to `true` — a one-line commit
- [ ] 8.3 Delete the retired support prices in the Paddle dashboard and unset the
      three `NEXT_PUBLIC_PADDLE_PRICE_ID_*` support variables in the hosting
      environment
