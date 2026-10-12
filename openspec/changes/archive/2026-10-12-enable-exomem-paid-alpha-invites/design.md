## Context

The repository already has operator-issued paid invites, alpha capacity accounting,
server-created Paddle transactions, checkout recovery, signed webhook dispatch,
subscription reconciliation, provider-neutral entitlements, idempotent lifecycle
operations, Home billing UI, and the private provisioner. The public self-serve
release built and proved those paths, then the friends-only change deliberately made
the public admission route return `410`, removed the new-checkout branch from the
billing route, and hid the Home checkout action.

The missing behavior is smaller than a new paid product: a paid operator invite must
reserve a place but wait for the existing Paddle projection before the existing
provisioner is released. The public €12 journey remains a later OpenSpec change.

## Goals / Non-Goals

**Goals:**

- Charge an operator-invited friend the configured €5 monthly price before provider
  work begins.
- Reuse the current invite, capacity, checkout, webhook, reconciliation,
  entitlement, and lifecycle boundaries.
- Converge to one capacity allocation and at most one initial provision operation
  under redemption, webhook, and reconciliation retries.
- Give the operator a simple email-and-send browser surface today.

**Non-Goals:**

- Public self-serve, the €12 public price, a new plan/catalog model, or waitlist UX.
- A new operator authentication/session service, tenant-management console,
  automatic reservation reaper, refunds, or plan switching.
- Changes to the cell protocol, gateway commands, or vault representation.

## Decisions

### 1. Paid operator invites reuse the existing Paddle source

`source=paid` already creates an operator invite with entitlement source `paddle`.
That is the private-alpha admission marker for this release. We will not add a
semantic plan column or another catalog abstraction: the public admission endpoint
remains `410`, so no public buyer can enter this flow, and the existing server-side
`EXOMEM_PADDLE_PRICE_ID` selects the live €5 price.

Paid invite creation will reuse the existing alpha pool lock and capacity arithmetic
to count hard allocations plus outstanding pending or delivered operator Paddle invites. This
is the same soft-promise rule already proved for self-serve, applied at the existing
operator invite transaction. Failed, revoked, expired, or consumed invitations stop
counting.

### 2. Redemption reserves capacity but does not provision

Paid invite redemption will use the existing admission transaction to create the
owner, tenant, `awaiting_checkout` Paddle entitlement, product session, and capacity
allocation. The existing capacity schema already permits a reserved allocation with
no `operation_id`, so no migration is required. Complimentary redemption keeps the
current immediate-provision behavior.

The first authoritative active or trialing Paddle projection will use the existing
event-store transaction to pin the live Hosted target, insert the normal
`initial-provision` lifecycle operation, and attach it to that allocation. Existing
uniqueness on `(tenant_id, operation_type, idempotency_key)` and allocation
`operation_id` makes retries converge. A missing allocation or live target fails the
transaction so the event remains retryable.

### 3. Selectively restore the checkout removed by the friends-only change

The billing route will restore its existing empty-body call to
`startOwnerCheckout`. The existing account guard already requires a Paddle-backed
owner without a customer and the checkout creator already selects product, price,
tenant, owner, environment, metadata, and return URL server-side. Home will restore
the existing `checkoutAvailable` summary and checkout action for
`awaiting_checkout` or `checkout_pending`.

There is no new release-switch variable. Existing fail-closed configuration is the
switch: new checkout requires the configured product, €5 price, return origin,
client token, environment match, and API key. Removing the sale price disables new
checkout while transaction inspection, webhooks, reconciliation, portal access, and
deletion continue. Public admission stays `410`, public copy stays friends-only, and
the €12 price is never configured into this release.

### 4. The operator page is a thin wrapper over existing APIs

`/exomem/operator` will call the existing bearer-authenticated capacity and invite
routes. The operator pastes `EXOMEM_ADMIN_TOKEN`; the page keeps it only in React
memory, sends it in the existing Authorization header, and requires re-entry after
refresh. It is never placed in cookies, local/session storage, URLs, analytics, or
logs. Because authorization is explicit rather than ambient, no new cookie exchange
or CSRF protocol is needed.

The page is absent from public navigation and sitemap, sends `no-store` and
`noindex`, shows coarse capacity, takes one email, defaults to paid, and offers a
separate explicit complimentary action.

## Risks / Trade-offs

- **A paid friend redeems but never checks out** → The hard reservation remains
  visible; the operator handles the four-person alpha manually. No automatic
  destructive reaper ships now.
- **Outstanding operator invites oversubscribe capacity** → Invitation creation
  serializes on the existing pool row and counts outstanding pending or delivered Paddle
  invites before sending another.
- **An old self-serve invite still exists** → Revoke outstanding self-serve invites
  in the rollout check; the public admission endpoint remains closed.
- **Paddle events arrive out of order or twice** → Existing exact transaction,
  subscription, event, and revision correlation remains authoritative; the new
  operation release happens inside that transaction and existing uniqueness
  converges retries.
- **The operator bearer is exposed to browser script** → Keep the page dependency
  surface minimal, retain the bearer only in memory, and ship no third-party scripts
  or persistence on the operator surface. A later multi-operator console can earn a
  dedicated login system.

## Migration Plan

1. Deploy the code with the existing public admission route still returning `410`
   and without the €5 sale price configured; verify complimentary access and Paddle
   event handling remain unchanged.
2. Revoke any outstanding historical self-serve invites and verify alpha capacity.
3. Map the existing Exomem Paddle product and `EXOMEM_PADDLE_PRICE_ID` to the live €5
   monthly price, without printing credentials or catalog identifiers.
4. Issue one controlled paid invitation, prove redemption creates no operation or
   provider resource, complete checkout, then prove exactly one operation and one
   ready isolated cell.
5. Roll back new checkout by removing the configured sale price. Continue processing
   existing subscriptions, portal actions, reconciliation, and deletion normally.

## Open Questions

None. Public €12 self-serve and a durable multi-operator login are separate future
changes.
