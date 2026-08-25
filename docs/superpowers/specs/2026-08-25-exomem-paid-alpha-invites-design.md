# Exomem Hosted Paid Alpha Invites

**Date:** 2026-08-25
**Status:** Approved for implementation

## Goal

Let the operator invite a friend to the private Exomem Hosted alpha, collect the
live €5/month Paddle subscription, and provision that person's isolated cell only
after Paddle has authoritatively confirmed an active or trialing subscription.

This change opens paid, operator-issued alpha admission. It does not open public
self-serve admission. The existing €12/month price remains outside the application
flow until the later public launch.

## Product boundary

The private alpha and the later public product are separate admission journeys:

- Private alpha: the operator selects an email, the service sends a one-use invite,
  the invitee accepts, pays €5/month, and is provisioned.
- Public launch: an anonymous visitor starts from the public €12/month pricing
  surface, passes capacity admission or joins the waitlist, pays, and is
  provisioned without an operator invitation.

They may share Paddle verification, entitlement projection, capacity accounting,
and lifecycle machinery. They must not share the admission entry point or make the
€12 price reachable during this change.

Complimentary operator invites remain supported and continue to provision without
Paddle. They are an explicit operator choice, never a fallback after billing fails.

## Rejected alternatives

### Charge before creating an Exomem identity

Sending a Paddle link before invite acceptance would avoid even a pending tenant,
but it complicates authoritative owner binding, capacity guarantees, failed-payment
recovery, and OAuth continuation. The existing server-created transaction flow
already binds Paddle to an authenticated Exomem owner and tenant safely.

### Provision before checkout

Provisioning first gives a friend only a small perceived head start while creating
real compute and storage spend for every abandoned checkout. It also turns payment
failure into a lifecycle cleanup problem. The alpha will reserve capacity before
checkout but will not create provider resources before verified payment.

## Admission and billing state flow

### 1. Operator issues the invite

The authenticated operator surface issues either:

- a paid private-alpha invite bound to the configured €5/month price; or
- an explicitly complimentary invite.

The paid invite stores the provider-neutral plan key
`private_alpha_monthly`; it never stores a browser-selected price. Production
configuration maps that key to the live €5/month Paddle price. The later public
flow will use a different `public_monthly` plan key, so enabling one journey
cannot accidentally expose the other price.

Paid invite issuance checks the configured alpha capacity against both hard
allocations and outstanding unexpired paid invitations. An outstanding paid invite
is a soft commitment: it prevents the operator from promising more slots than the
pool contains, but it creates no tenant or provider resource. An expired, revoked,
or delivery-failed invite no longer counts.

The pool row is locked while the service counts existing allocations and soft
commitments and inserts the new invite. Concurrent operator requests therefore
cannot both promise the last slot.

The email remains bound to a one-use fragment token. Email and tokens must not enter
application logs, telemetry, URLs visible to servers, or Paddle metadata.

### 2. Paid invite acceptance reserves capacity without provisioning

Accepting a valid paid invite is one database transaction. It:

1. locks and validates the invite and live hosted cohort;
2. creates or resolves the verified owner and their single Exomem tenant;
3. creates a Paddle entitlement in `awaiting_checkout`;
4. reserves the tenant's storage, runtime, and provision capacity;
5. creates the product session and consumes the invite.

It does **not** create a lifecycle operation, cell, volume, provider claim, or
provisioner request. The capacity allocation remains `reserved` with no operation
until verified payment releases it to provisioning.

If hard capacity cannot be reserved, the transaction changes nothing and leaves the
invite reusable. The browser reports that the private alpha is currently full.

Complimentary acceptance retains the current atomic behavior: reserve capacity,
create the initial provision operation, and let the scheduler converge it.

### 3. Home collects payment

For a Paddle entitlement in `awaiting_checkout` or `checkout_pending` with no
provision operation, Home renders a dedicated `awaiting_payment` state rather than
the generic preparing screen. It shows:

- Private alpha at €5/month;
- that billing starts before the private service is prepared;
- one primary **Subscribe and prepare Exomem** action; and
- recovery of an already-bound open Paddle transaction.

The checkout route accepts an empty authenticated POST to start or resume the
owner's server-created Paddle transaction. The server selects the configured live
alpha price; the browser never supplies a product, price, tenant, user, environment,
or redirect URL. Paddle.js opens only the returned owner-bound transaction.

The checkout return is a latency optimization and navigation aid. It is never proof
of payment.

### 4. Verified Paddle activation releases provisioning

Only a correctly signed event for the configured environment, product, bound
transaction, owner, and tenant may release the reservation. Both
`subscription.created` and `subscription.activated` must be able to establish the
subscription from the exact bound transaction because Paddle delivery order and
event choice are not assumed.

Applying the first authoritative `active` or `trialing` subscription revision is
one database transaction. It:

1. claims the Paddle event idempotently;
2. binds the customer and subscription references;
3. projects the paid entitlement state;
4. pins the current live hosted contract;
5. creates exactly one `initial-provision` lifecycle operation; and
6. attaches that operation to the existing reserved capacity allocation.

The event receipt, entitlement projection, operation creation, and allocation
attachment commit together. If the live contract or reserved allocation is absent,
the event remains retryable and no partial activation receipt is committed.

Repeated, stale, or reordered events cannot create a second operation or allocate a
second cell. The external scheduler then handles ordinary provisioning. Home moves
from `awaiting_payment` to `preparing`, then to `ready` only after the existing full
private readiness proof.

### 5. Abandoned and failed checkout

An abandoned or failed checkout creates no infrastructure cost. The logical
capacity reservation remains visible to the operator and is handled manually for
the four-person alpha; this design intentionally adds no automatic destructive
reaper. An unredeemed invite expires naturally and stops counting as a soft
commitment.

Existing product deletion remains the safe path for a redeemed unpaid tenant. It
must cancel an authoritative pending Paddle transaction before releasing capacity,
even though no cell exists.

## Operator surface

`/exomem/operator` is a private operational surface, not part of the public Exomem
navigation or sitemap. It contains:

- a short-lived operator sign-in established from the existing
  `EXOMEM_ADMIN_TOKEN` without retaining the plaintext token in browser storage;
- current alpha capacity and outstanding paid-invite commitments;
- an email field;
- a fixed **Paid private alpha · €5/month** default;
- an explicit **Complimentary** alternative; and
- a clear success or refusal result after sending.

The browser exchanges the operator bearer once for a Secure, HttpOnly, SameSite
operator session with an eight-hour absolute lifetime. The cookie is purpose-bound
and authenticated with a domain-separated key derived from the existing control-plane
key; it contains no bearer or email. The exchange request is origin-checked,
rate-limited, `no-store`, and content-free in logs. Operator mutations require the
session plus the existing same-origin/CSRF validation. Existing bearer-authenticated
admin APIs remain available for automation and runbooks.

The first release needs invite issuance and capacity visibility. A complete tenant
management console, automated reservation reaping, refunds, price management, and
public self-serve administration are out of scope.

## Configuration

The active Exomem Paddle price configuration points to the live €5/month private
alpha price. Startup and checkout validation continue to bind one environment,
credential set, product, price, and client token. The €12/month price remains active
in Paddle if desired but is not referenced by this application release.

`EXOMEM_PAID_ALPHA_CHECKOUT_ENABLED` is the explicit release switch. Only the exact
trimmed value `true` permits paid invite issuance or a new checkout. Webhook and
reconciliation handling remain enabled while the switch is off so rollback cannot
strand an already-paid owner.

No identifier or credential is committed. Deployment verification compares the
configured identifiers to the intended Paddle catalog without printing them.

## Errors and recovery

- No soft or hard capacity: refuse before checkout and preserve an unconsumed invite
  where applicable.
- Paddle configuration unavailable: show a retryable billing error; do not enqueue
  provisioning.
- Checkout canceled: clear the exact bound transaction when Paddle proves it is
  canceled, then allow a new server-created transaction.
- Paid event cannot bind to the exact owner, tenant, transaction, environment,
  product, and price: reject it without changing entitlement or lifecycle state.
- Paddle activation cannot atomically attach a provision operation: return a
  retryable webhook failure so Paddle can redeliver; alert the operator without
  logging billing identifiers.
- Provisioning fails after payment: retain the active entitlement and reserved
  capacity, show the existing preparing/degraded state, and recover through the
  durable lifecycle operation. Never silently cancel or refund from a reconciler.

## Verification

Implementation is complete only when all of the following pass:

1. Unit and PostgreSQL integration tests prove paid invite acceptance reserves
   capacity but creates no operation, cell, or provider claim.
2. Complimentary invite regression tests prove immediate provisioning is unchanged.
3. Checkout route tests prove an authenticated awaiting-payment owner can start and
   resume exactly one server-created €5 transaction and cannot select catalog data.
4. Webhook integration tests prove `subscription.created` and
   `subscription.activated` can each atomically release exactly one provision
   operation from the bound transaction, including duplicate and reordered delivery.
5. Failure tests prove no event receipt or partial entitlement transition commits if
   the allocation or live target is missing.
6. Operator route and browser tests prove authentication, origin/CSRF checks,
   capacity refusal, paid-by-default issuance, explicit complimentary issuance, and
   absence from public navigation.
7. Chrome DevTools verifies the real operator, awaiting-payment, Paddle return,
   preparing, error, keyboard, and narrow-screen interactions.
8. A Paddle sandbox smoke proves invite → acceptance → checkout → verified webhook →
   provisioning enqueue without a provider call before payment.
9. Production rollout first verifies the live €5 catalog binding and webhook
   destination, then uses one controlled paid founder transaction. Provider and
   control-plane observations must prove zero cell/volume before activation and one
   ready isolated cell afterwards.

## Rollout and rollback

Apply the additive database migration before deploying application code. Deploy with
`EXOMEM_PAID_ALPHA_CHECKOUT_ENABLED` absent or `false`, verify operator/session and
state reads, then set it to `true` and issue one controlled paid invite.

Rollback disables new paid checkout and paid invite issuance. Existing verified
subscriptions continue through the normal entitlement and deletion machinery;
rollback must not orphan or silently cancel them. Complimentary invitations remain
available to the operator.
