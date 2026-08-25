## Why

Exomem Hosted is technically ready for private alpha, but the only launch-safe
invite path is complimentary: paid invitees can neither start the existing Paddle
checkout nor prove payment before provisioning consumes infrastructure. The private
friends alpha needs a €5/month, operator-issued path now, while the later €12/month
public self-serve journey remains closed.

## What Changes

- Add a private operator console for capacity visibility and one-at-a-time paid or
  explicitly complimentary invitation.
- Bind paid alpha invitations to a provider-neutral private-alpha plan key mapped
  server-side to the live €5/month Paddle price.
- Reserve logical alpha capacity when a paid invitation is redeemed without
  creating a lifecycle operation or contacting the provisioner.
- Enable an authenticated awaiting-payment owner to start or resume the existing
  server-created Paddle checkout.
- Make the first verified active or trialing subscription event atomically release
  exactly one provisioning operation from the reserved allocation.
- Keep public self-serve admission and the €12/month price unreachable.
- Add a fail-closed release switch, migration, operator runbook, sandbox acceptance,
  and production rollout proof.

## Capabilities

### New Capabilities

- `exomem-operator-console`: Private operator authentication, capacity visibility,
  and paid-by-default invitation issuance.

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

This affects Exomem invite/session APIs, capacity and lifecycle PostgreSQL
transactions, Paddle checkout and webhook projection, Home state derivation, the new
operator UI/API surface, database migrations, configuration validation, tests, and
the Hosted alpha runbook. It changes no cell protocol, gateway command, vault data,
public navigation, or Endstate billing behavior.
