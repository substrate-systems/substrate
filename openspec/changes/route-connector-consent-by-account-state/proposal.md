## Why

The connector consent page (`/exomem/authorize`) showed one view to every signed-out
visitor and one Connect button to every signed-in one, whatever their account state.
Each gap is a broken first connection:

- An active owner read the signed-out page as a sign-up form. It led with the invitation
  email and a reviewer form, and sign-in was a small link.
- An owner who had not paid yet was offered Connect, and the consent gate accepted it.
  Every tool call on that connection then failed with `CELL_NOT_READY`.
- A paid invite redeemed on the consent page minted an authorization code before
  payment, and the page promised that the visitor would not need to come back.
- A paused, cancelled or suspended owner was offered Connect, and pressing it showed a
  raw `{"error":"access_denied"}` body.
- Home showed an owner whose checkout had started (`checkout_pending`) as paused.

Friends join Exomem through paid invites, so their first connection runs through exactly
these paths.

## What Changes

- The consent page computes one next step on the server from the session and the
  entitlement: sign in, subscribe, connect, connect read-only, ended, paused or
  suspended. Unknown states and storage errors render the signed-out view.
- The signed-out view leads with Sign in, then "New here? Use your invitation".
  Reviewer access moves into a "Reviewing Exomem for a directory?" disclosure.
- "Awaits first payment" and "can connect" are defined once, in `entitlements.ts`. The
  consent gate SQL, Home's Cloud status and the page's step all read that definition.
  The consent gate now refuses an owner whose first payment is outstanding.
- A paid invite redeemed under an OAuth continuation admits the owner and signs them in,
  but writes no grant or code and leaves the OAuth transaction open. The consent page
  continues at Subscribe.
- Subscribe opens the existing Paddle checkout on the consent page. A settled checkout
  returns to the consent page while its OAuth transaction is live, otherwise to Home.
  The target comes from the httpOnly continuation cookie, never from the caller.
- A refused Connect redirects to a fresh consent page instead of a 403 JSON body. A
  Connect submitted after the request expired redirects to the expired-request page.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `exomem-hosted-access`: adds the requirement that the connector consent page routes
  each account state to its next step.

## Impact

- `src/app/exomem/authorize/*`: page, client, step and section modules.
- `src/lib/exomem-hosted/entitlements.ts`, `oauth-store.ts` (consent gate),
  `cloud-status.ts`, `cloud-admission.ts`, `oauth-continuity.ts`, `hosted-browser.ts`.
- Routes: `access/redeem`, `oauth/authorize/invite`, `oauth/authorize/complete`,
  `billing/checkout`, `access/magic-link/redeem`, `access/reviewer`, `oauth/authorize`.
- No migration and no new authentication mechanism.
