## Why

Exomem Hosted already contains the self-serve Paddle, capacity, entitlement, and
provisioning machinery, but the friends-only release deliberately disabled starting
checkout. Paid operator invitees therefore provision before paying and cannot open
the checkout that already exists. The private alpha needs that narrow seam restored
for the live €5 price while public self-serve remains closed.

## What Changes

- Reuse the existing paid operator invite, capacity ledger, Paddle checkout,
  entitlement projection, and lifecycle machinery instead of adding a parallel
  billing flow.
- Reserve alpha capacity when a paid operator invitation is redeemed without
  creating a lifecycle operation or contacting the provisioner.
- Selectively restore the existing authenticated checkout and Home action for an
  awaiting-payment Paddle invitee.
- Make verified active or trialing subscription projection attach exactly one
  existing-style provisioning operation to the reserved allocation.
- Add a thin private operator page over the existing bearer-authenticated invite and
  capacity APIs; the bearer remains in page memory and is never persisted.
- Keep public self-serve admission and the €12/month price unreachable.
- Use the existing fail-closed Paddle catalog configuration, plus runbook, sandbox
  acceptance, and production rollout proof.

## Capabilities

### New Capabilities

- `exomem-operator-console`: A private browser wrapper over existing operator
  capacity and invitation APIs.

### Modified Capabilities

- `exomem-hosted-access`: Paid invite issuance and redemption become
  capacity-aware without provisioning before payment.
- `exomem-hosted-entitlements`: Awaiting-payment checkout and verified Paddle
  activation become the authority that releases provisioning.
- `exomem-tenant-control-plane`: A paid tenant may hold reserved capacity without
  an initial provision operation until authoritative activation.
- `exomem-home`: Home gains an explicit awaiting-payment journey before preparing
  and ready states.

## Impact

This affects paid-invite redemption, lifecycle release during existing Paddle
projection, the existing billing checkout route and Home action, a small operator
page, tests, and the Hosted alpha runbook. It adds no billing provider, catalog
model, operator API, database table, cell protocol, gateway command, public
navigation, or Endstate billing behavior.
