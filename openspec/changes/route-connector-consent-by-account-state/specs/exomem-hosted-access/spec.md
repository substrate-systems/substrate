## ADDED Requirements

### Requirement: The connector consent page routes each account state to its next step

The connector consent page SHALL compute one next step on the server from the visitor's
session and entitlement, and SHALL offer only that step. It SHALL offer Connect exactly
when the consent gate would grant it: the effective state is `provisioning`, `active` or
`grace`, and the entitlement does not await its first payment. An unknown state or a
storage error SHALL render the signed-out view. Every return to the consent page SHALL
use a destination the server derives from the OAuth continuation cookie, never one the
caller supplies, and no step SHALL reveal to a signed-out visitor whether an email has
an account.

#### Scenario: Signed-out visitor

- **WHEN** a visitor with no usable session opens the consent page for a live OAuth request
- **THEN** the page leads with Sign in, which returns to the same consent page after the magic link
- **AND** it then offers "New here? Use your invitation", with a paste fallback
- **AND** reviewer access sits last, behind a "Reviewing Exomem for a directory?" disclosure

#### Scenario: Complimentary invite redeemed on the consent page

- **WHEN** a visitor redeems a complimentary invite while the consent page's OAuth continuation is live
- **THEN** the system admits them, mints the authorization code, and connects the app in one step

#### Scenario: Paid invite redeemed on the consent page

- **WHEN** a visitor redeems a paid invite while the consent page's OAuth continuation is live
- **THEN** the system admits and signs them in, but writes no grant or authorization code
- **AND** the OAuth transaction stays unconsumed, and the browser returns to the consent page at Subscribe

#### Scenario: Owner whose first payment is outstanding

- **WHEN** a signed-in owner's entitlement is `awaiting_checkout` or `checkout_pending`
- **THEN** the page offers Subscribe, which opens the existing checkout, and no Connect
- **AND** the consent gate refuses a grant for that owner

#### Scenario: Checkout settles

- **WHEN** a checkout started from the consent page settles
- **THEN** the browser returns to the consent page while its OAuth transaction is live, and to Home otherwise
- **AND** the consent page then offers Connect

#### Scenario: Paid or complimentary owner

- **WHEN** a signed-in owner's entitlement is active, trialing or complimentary
- **THEN** the page offers Connect
- **AND** while the cell is still being prepared, a note says the tools start working within a few minutes

#### Scenario: Payment failed

- **WHEN** a signed-in owner's entitlement is `past_due`
- **THEN** the page offers Connect with a notice that payment failed and Exomem is read-only, and a Manage billing action

#### Scenario: Subscription cancelled

- **WHEN** a signed-in owner's subscription is cancelled
- **THEN** the page says the subscription has ended, offers no Connect, and points to export from Home and to support

#### Scenario: Subscription paused

- **WHEN** a signed-in owner's subscription is paused
- **THEN** the page says the subscription is paused, offers Manage billing, and offers no Connect

#### Scenario: Exomem suspended by the operator

- **WHEN** a signed-in owner's Exomem is suspended for any reason other than a paused subscription
- **THEN** the page says the Exomem is suspended and points to support, and offers no Connect

#### Scenario: Deleted account

- **WHEN** a visitor whose account is deleted or awaiting deletion opens the consent page
- **THEN** the page renders the signed-out view, and sign-in stays non-enumerating

#### Scenario: Connect refused after the page rendered

- **WHEN** the consent gate refuses a Connect because the account changed after the page rendered
- **THEN** the system redirects to a fresh consent page that shows the step for the current state, not a JSON error body

#### Scenario: Connect after the request expired

- **WHEN** a Connect arrives after its OAuth request expired or was used
- **THEN** the system redirects to a consent page that says the request expired and to start again from the app
