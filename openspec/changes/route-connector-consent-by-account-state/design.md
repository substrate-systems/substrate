## Context

The consent page decides what a visitor can do next, and the consent gate
(`attachExistingOwnerAuthorizationAtomic`) decides whether a grant is written. Before
this change the page knew only "signed in or not", and the gate accepted any effective
state of `provisioning`, `active` or `grace`. A tenant that awaits its first payment is
also `provisioning`, so the gate accepted it.

## Decisions

### A paid invite pays before its first grant

A complimentary invite redeemed on the consent page still connects in one step. A paid
invite admits the tenant, cell and session in the same transaction, but writes no grant
or authorization code and leaves the OAuth transaction unconsumed. The decision is made
inside `admitFirstCloudOAuthInviteAtomic`, under the invite's row lock, because the
invite's source is only known there and both OAuth invite routes call that function.

### One definition of "can connect"

`canConnect` is a connectable effective state (`provisioning`, `active`, `grace`) and a
source state that does not await a first payment (`awaiting_checkout`,
`checkout_pending`). The gate binds the same two lists as SQL parameters. The page
offers Connect exactly when `canConnect` holds, so the page and the gate cannot disagree.

### The server picks every return target

Sign-in, checkout settle and a refused Connect all return to
`/exomem/authorize?confirmation=<handle>`, derived from the httpOnly continuation cookie
by one helper. No request parameter selects a destination.

## Risks / Trade-offs

- A cancelled account sees "Your subscription has ended" with export and support links,
  not a Resubscribe button. The checkout routes refuse a tenant that already has a
  provider customer, so a self-serve resubscription needs a billing change first.
- The gateway still answers `CELL_NOT_READY` for a pre-payment token minted before this
  change. No new one can be minted.
- The OAuth transaction lives 10 minutes. A checkout that takes longer ends on the
  expired-request page, and the second attempt from the app connects directly.
