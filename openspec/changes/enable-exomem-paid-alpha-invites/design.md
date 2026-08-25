## Context

Substrate already has the hard Hosted foundations: operator-issued invitations,
email-bound redemption, product sessions, provider-neutral entitlements, durable
capacity accounting, idempotent lifecycle operations, server-created Paddle
transactions, signed webhook dispatch, subscription reconciliation, Home, and a
private provisioner. The live Paddle catalog already contains the Exomem Hosted
product with €5/month private-alpha and €12/month future-public prices.

The friends alpha intentionally disabled starting a new checkout, and paid invite
redemption currently follows the same provisioning path as complimentary access.
That combination is unsafe to launch: a paid invite can consume infrastructure
before it has paid, while its owner has no supported way to start checkout.

The alpha pool has four runtime slots. Admission must therefore serialize soft
promises, hard reservations, payment activation, and provisioning without opening
public self-serve or inventing an automated destructive reaper.

## Goals / Non-Goals

**Goals:**

- Give the operator a small private console for capacity and invitation issuance.
- Charge an invited friend €5/month before any provider resource is created.
- Guarantee one logical capacity reservation and at most one initial provision
  operation per paid tenant under retries, duplicate webhooks, and concurrency.
- Keep existing complimentary invites and provider-neutral enforcement intact.
- Deploy and rollback behind a fail-closed paid-alpha release switch.

**Non-Goals:**

- Public self-serve, the €12/month public price, waitlist UX, or public pricing.
- A general tenant-management console, automatic reservation reaping, refunds, or
  subscription-plan switching.
- Changes to the Exomem cell protocol, gateway commands, or vault representation.

## Decisions

### 1. Reserve capacity at paid redemption, provision at verified activation

Paid redemption will atomically create the owner, tenant, awaiting-checkout
entitlement, product session, and ordinary capacity allocation. The allocation is
`reserved` with a null `operation_id`. No lifecycle operation, cell, volume,
provider claim, or provisioner call exists yet.

The first authoritative `active` or `trialing` Paddle subscription revision will
atomically project the entitlement, pin the live hosted target, create the
`initial-provision` operation, and attach it to that allocation. The scheduler then
uses the existing lifecycle path.

This keeps the promise made to a friend without spending compute before payment.
Charging before identity was rejected because it weakens owner correlation and
checkout recovery. Provisioning before checkout was rejected because it creates
real spend for abandoned invitations.

### 2. Outstanding paid invites are serialized soft commitments

Paid invite issuance will lock the alpha capacity-pool row, count hard allocations
and unexpired, unrevoked, successfully deliverable paid invitations, and insert the
new invite only if one slot remains. The invitation stores the provider-neutral plan
key `private_alpha_monthly`. Expired, revoked, or delivery-failed invites stop
counting without deletion.

Redemption still performs the authoritative hard reservation. If capacity differs,
the transaction leaves the invitation unconsumed and changes nothing.

The later public journey will use a separate `public_monthly` plan key and admission
entry point. Provider-neutral keys prevent the browser from choosing catalog IDs and
prevent this release from exposing the €12 price.

### 3. Awaiting payment is a derived product state

No new tenant lifecycle enum is required. A Paddle entitlement in
`awaiting_checkout` or `checkout_pending`, with a reserved allocation and no initial
provision operation, deterministically projects Home state `awaiting_payment`.

Home will show the fixed private-alpha offer and one **Subscribe and prepare
Exomem** action. An empty authenticated, CSRF-valid checkout POST starts or resumes
the server-created transaction. The browser supplies no plan, price, product,
environment, tenant, owner, or return URL.

The checkout return only validates and reopens or reconciles the bound transaction.
It is never payment authority.

### 4. Paddle activation and operation release are one transaction

The Paddle event store remains the atomic boundary. For the first authoritative
active/trialing subscription revision it must claim the event receipt, bind provider
references, update the entitlement, create the one pinned provision operation, and
attach the reservation in the same SQL transaction.

Both `subscription.created` and `subscription.activated` may establish a
subscription from the exact bound transaction. This is required because Paddle may
deliver either event first. Correlation still requires the configured environment,
product, semantic plan, owner, tenant, and authoritative transaction or existing
subscription reference.

If the reservation or live target is missing, the statement throws before commit;
the webhook returns a retryable failure and no receipt falsely records success.
Duplicate and stale revisions cannot create a second operation because event,
tenant-operation, allocation-operation, and provider-reference constraints converge
on the original state.

### 5. Operator authentication exchanges the bearer for an HttpOnly session

The private `/exomem/operator` page is absent from public navigation and sitemap.
The operator enters the existing `EXOMEM_ADMIN_TOKEN` once. A rate-limited,
same-origin, `no-store` endpoint compares it in constant time and returns an
eight-hour Secure, HttpOnly, SameSite cookie authenticated with a domain-separated
key derived from `EXOMEM_CONTROL_PLANE_KEY`.

The cookie contains no bearer or email. Operator mutations validate origin and a
session-bound CSRF token. Existing bearer-authenticated admin APIs remain unchanged
for automation. A token kept in browser storage was rejected because any script on
the origin could read it; a separate OAuth provider or Cloudflare Access deployment
was rejected as unnecessary alpha scope.

The first console ships only authentication, capacity/soft-commitment visibility,
email input, paid-by-default invitation, explicit complimentary invitation, and
clear success/refusal states.

### 6. One release switch gates new money-changing entry points

Only exact trimmed `EXOMEM_PAID_ALPHA_CHECKOUT_ENABLED=true` permits new paid
invitations or new checkout transactions. Webhook and reconciliation processing stay
enabled while the switch is off so rollback cannot strand already-paid owners.

Production configuration maps `private_alpha_monthly` to the live €5 price. The
€12 price may remain active in Paddle but is not referenced by this release.

## Risks / Trade-offs

- **A redeemed friend never pays and holds one logical slot** → Show the hold in the
  operator console and handle it manually during the four-person alpha. Add no
  automatic destructive reaper.
- **Paddle activation arrives before `subscription.created`** → Permit
  `subscription.activated` to bind from the exact recorded transaction and retain
  return-path reconciliation as a latency fallback.
- **Payment succeeds while the live cohort is unavailable** → Fail the webhook
  retryably without committing its receipt; alert the operator and let Paddle
  redeliver after the target is repaired.
- **The feature switch is disabled after payment** → Continue webhook,
  reconciliation, portal, and deletion handling; gate only new paid admission and
  checkout creation.
- **Operator-session code broadens the security boundary** → Keep the session
  product-scoped, short-lived, purpose-bound, origin/CSRF protected, rate-limited,
  and covered by cookie, replay, and logging tests.
- **The €5 and €12 prices share one Paddle product** → Correlate only the
  server-created transaction for the configured semantic plan; never activate from
  product membership or browser-supplied catalog data alone.

## Migration Plan

1. Apply an additive migration for invite plan keys and reservation-without-operation
   invariants. Existing invites, entitlements, and allocations retain their meaning.
2. Deploy application code with `EXOMEM_PAID_ALPHA_CHECKOUT_ENABLED` absent or
   false. Verify migrations, operator sign-in, capacity reads, and paid-state
   derivation without allowing new paid mutations.
3. Verify the production environment maps `private_alpha_monthly` to the intended
   live €5 Paddle price and that the signed webhook destination is active, without
   printing identifiers or credentials.
4. Enable the switch and issue one controlled paid invitation.
5. Prove database and provider state contain no cell, volume, claim, or provisioner
   call before activation; complete checkout; then prove exactly one operation and
   one ready isolated cell.
6. Disable the switch to roll back new paid admission. Continue processing existing
   subscriptions and use normal billing/deletion controls; do not silently cancel or
   orphan them.

## Open Questions

None. Public €12 self-serve and automated abandoned-reservation policy are explicit
future changes.
