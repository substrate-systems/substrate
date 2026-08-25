## 1. Payment-First Data Model

- [ ] 1.1 Add a migration for invite semantic plan keys and reserved allocations without lifecycle operations, preserving all existing rows
- [ ] 1.2 Add database constraints and indexes that enforce one hard reservation and at most one attached initial operation per tenant
- [ ] 1.3 Extend migration, upgrade, and PostgreSQL integration tests for paid redemption, capacity contention, rollback, and legacy compatibility

## 2. Capacity-Safe Invitation Flow

- [ ] 2.1 Extend invitation records and delivery models with complimentary and private_alpha_monthly access kinds
- [ ] 2.2 Implement serialized paid-invite soft commitments against the alpha capacity pool, excluding expired, revoked, and failed deliveries
- [ ] 2.3 Make paid redemption atomically create the owner, tenant, awaiting-checkout entitlement, session, and operation-free reservation
- [ ] 2.4 Preserve immediate provisioning for complimentary redemption and add concurrency and idempotency tests for both paths

## 3. Paid Checkout and Activation

- [ ] 3.1 Add fail-closed private_alpha_monthly Paddle configuration and the EXOMEM_PAID_ALPHA_CHECKOUT_ENABLED release switch
- [ ] 3.2 Enable an awaiting-payment owner to start or resume only its server-selected €5 checkout without accepting catalog or routing selectors
- [ ] 3.3 Atomically release exactly one pinned initial provisioning operation when the first verified active or trialing subscription is projected
- [ ] 3.4 Support subscription.created or subscription.activated arriving first and test duplicate, stale, missing-reservation, missing-target, and Endstate-isolation cases

## 4. Private Operator Console

- [ ] 4.1 Implement rate-limited bearer exchange into an eight-hour product-scoped Secure, HttpOnly, SameSite operator session with CSRF and origin protection
- [ ] 4.2 Add private operator APIs for capacity visibility and paid-by-default or explicitly complimentary invitation issuance
- [ ] 4.3 Build the non-indexed /exomem/operator sign-in and invite console with clear success, refusal, and capacity states
- [ ] 4.4 Add route, cookie, privacy, authorization, concurrency, and rendered interaction tests for the operator flow

## 5. Awaiting-Payment Home

- [ ] 5.1 Derive awaiting_payment from entitlement, reservation, and operation state without adding a tenant lifecycle enum
- [ ] 5.2 Render the fixed €5 private-alpha offer and Subscribe and prepare Exomem action without provisioning progress before activation
- [ ] 5.3 Add Home and checkout-route tests covering disabled configuration, transaction resume, checkout return, activation, and transition to preparing
- [ ] 5.4 Inspect operator and Home flows in Chrome DevTools at desktop and narrow viewport sizes, including keyboard focus and failed requests

## 6. Operations and Release Proof

- [ ] 6.1 Update the Hosted alpha runbook and configuration contract for paid invites, release-switch rollback, Paddle event ordering, and no-prepayment provisioning checks
- [ ] 6.2 Run focused unit, route, PostgreSQL integration, migration, security, and static verification suites
- [ ] 6.3 Prove the full sandbox flow from paid invitation through checkout and verified activation to exactly one provisioning operation
- [ ] 6.4 Deploy with the switch off, verify the live €5 mapping and webhook health, enable it, and complete one controlled paid production invitation
