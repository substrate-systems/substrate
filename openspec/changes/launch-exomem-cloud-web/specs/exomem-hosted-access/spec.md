## RENAMED Requirements

- FROM: `### Requirement: Exomem access is invite only during alpha`
- TO: `### Requirement: Exomem access starts with an email, an invitation or a waitlist place`

## MODIFIED Requirements

### Requirement: Exomem access starts with an email, an invitation or a waitlist place

Access SHALL start in one of three ways: a person asks with their email at the start form, an operator issues an invitation, or a person waits for a place on the waitlist. Each invitation MUST be bound to one normalized email address, an entitlement source, an expiry and a single high-entropy token. The system MUST store the digest of the token, not the plaintext. The setting `EXOMEM_SELF_SERVE_ADMISSION` (`closed`, `waitlist` or `open`) SHALL decide what a new address receives. The default is `closed`.

#### Scenario: Operator creates a complimentary invite

- **WHEN** an operator with valid Exomem invite authority creates an unexpired complimentary invite for an email address
- **THEN** the system stores a single-use digest-bound invite and returns or delivers one redemption URL
- **AND** the plaintext token is not written to logs or retained in the database

#### Scenario: Public caller attempts to create an invite

- **WHEN** a caller without operator authority invokes the invite creation boundary
- **THEN** the system rejects the request without revealing invite or account state

#### Scenario: Admission is closed

- **WHEN** the setting is `closed` and an address with no tenant submits the start form
- **THEN** the system sends no email and creates no invitation and no waitlist entry
- **AND** the response is the same as for every other verified request

#### Scenario: Admission is open and a place is free

- **WHEN** the setting is `open`, Cloud has a free place, nobody waits, and a new address submits the start form
- **THEN** the system creates a start invitation that expires 48 hours after creation
- **AND** it queues one start email for that address

#### Scenario: Admission is open and Cloud is full

- **WHEN** the setting is `open` and Cloud has no free place, or at least one person waits, and a new address submits the start form
- **THEN** the system adds the address to the waitlist and queues the waitlist email
- **AND** it creates no invitation

#### Scenario: Admission is waitlist only

- **WHEN** the setting is `waitlist` and a new address submits the start form
- **THEN** the system adds the address to the waitlist even when Cloud has a free place

### Requirement: Existing users can request a non-enumerating sign-in link

The start form SHALL check every request with a Cloudflare Turnstile challenge and SHALL answer every request that passes the challenge in the same way. An existing owner SHALL receive a short-lived, single-use sign-in link by email. The response, the challenge cookie and the minimum response time MUST NOT depend on whether the address has an account, is malformed, is rate limited, or was waitlisted. The former sign-in link route SHALL use the same handler, so no caller can skip the challenge. A start request MUST NOT create an account or tenant. It MAY create an invitation or a waitlist entry.

#### Scenario: Existing Exomem owner requests a link

- **WHEN** an existing owner submits their normalized email with a valid challenge token within rate limits
- **THEN** the system queues a sign-in link email and returns the generic acknowledgement

#### Scenario: Unknown address requests a link

- **WHEN** an address with no Exomem tenant submits the same request
- **THEN** the system returns the same acknowledgement, with a byte-identical `Set-Cookie`, and creates no identity, tenant or entitlement
- **AND** the response takes at least as long as the minimum response time

#### Scenario: Challenge token is missing, invalid or reused

- **WHEN** the request carries a missing, invalid or already used challenge token
- **THEN** the system answers 400 `challenge_failed` before it reads the email
- **AND** the answer depends only on the token

#### Scenario: Challenge service is unreachable

- **WHEN** the challenge verification request fails or times out
- **THEN** the request continues under the per-address and per-network rate limits

#### Scenario: Request is rate limited or malformed

- **WHEN** the address is malformed, or the network or the address exceeds its hourly limit
- **THEN** the system returns the same acknowledgement as for an accepted request and sends nothing

#### Scenario: Former sign-in route is called

- **WHEN** a caller posts to the former sign-in link route
- **THEN** the same challenge, rate limits and padding apply

## ADDED Requirements

### Requirement: Waitlisted people are admitted first come, first served

While the setting is `open`, the system SHALL admit waiting people in the order they joined, one for each free Cloud place. A new address MUST NOT pass a person who waits. A person who asks again while still waiting SHALL keep their place. A person whose place-opened link expired unused SHALL join the back of the queue when they ask again. The system MUST NOT reveal a queue position and MUST NOT admit anyone while Cloud capacity observations are stale.

#### Scenario: A place opens

- **WHEN** a Cloud place becomes free and people wait
- **THEN** the system creates a start invitation for the oldest waiting person, marks them admitted and queues the place-opened email
- **AND** each admission commits in its own transaction under the capacity lock

#### Scenario: Newcomer arrives while people wait

- **WHEN** Cloud has a free place, someone already waits, and a new address submits the start form
- **THEN** the new address joins the back of the waitlist

#### Scenario: Waiting person asks again

- **WHEN** a person who still waits submits the start form again
- **THEN** their entry keeps its place and no second entry exists

#### Scenario: Place-opened link expired unused

- **WHEN** a person's place-opened link expires unused and they submit the start form again
- **THEN** they join the back of the queue

#### Scenario: Promotion runs twice at once

- **WHEN** two promotion runs overlap with one free place
- **THEN** exactly one person is admitted

### Requirement: Invitation and hold emails are sent once

Every Exomem email SHALL go through the email outbox. The system MUST enqueue each email in the same transaction as the fact that causes it, under a unique dedupe key. Delivery SHALL be at least once under a lease, and the dedupe key SHALL make the send once. Each kind MUST re-check its precondition when claimed and become cancelled if it no longer holds. Each time limit in an email SHALL render at send time in the recipient's time zone, or labelled UTC when the zone is unknown.

#### Scenario: The same fact is recorded twice

- **WHEN** a retry records the same causing fact twice
- **THEN** one outbox row and one email exist for that dedupe key

#### Scenario: Precondition no longer holds

- **WHEN** the system claims a reminder after the person has already used the invitation
- **THEN** the row becomes cancelled and no email is sent

#### Scenario: Invitee reminder

- **WHEN** an operator issues an invitation
- **THEN** the system queues a reminder for three days before the invitation expires, with the token encrypted in the payload
- **AND** it sends the reminder only while the invitation is still usable

#### Scenario: Inviter notices

- **WHEN** a friend invitation with an inviter email is used
- **THEN** the system queues "used" to the inviter inside the consuming transaction
- **AND** when it expires unused, the system sends "ended unused" to the inviter only if no one used it

#### Scenario: Hold reminder

- **WHEN** a person who has not paid accepts an invitation and the cell stops
- **THEN** the system queues the hold reminder for five days after the cell's creation
- **AND** it cancels the reminder if the cell no longer stops or the tenant has paid

#### Scenario: Recipient time zone is unknown

- **WHEN** the system renders a time limit for a recipient with no stored time zone
- **THEN** the time shows in UTC with the label

### Requirement: Start and redemption record the person's time zone

The start form and the redemption routes SHALL accept an optional IANA time zone name. The system SHALL check it against the closed IANA set and SHALL store the time zone as unknown when the name is not in the set.

#### Scenario: Valid time zone

- **WHEN** a redemption carries `Europe/Lisbon`
- **THEN** the tenant stores that time zone

#### Scenario: Unknown time zone

- **WHEN** a redemption carries a name outside the IANA set
- **THEN** the request succeeds and the tenant's time zone stays unknown

### Requirement: A paid web redemption continues in the setup journey

A paid redemption that began on the web, with no live OAuth continuation, SHALL lead to the setup journey, not to Home. A redemption under a live OAuth continuation SHALL keep returning the consent path.

#### Scenario: Paid web redemption

- **WHEN** a person redeems a paid invitation from the web with no live OAuth continuation
- **THEN** the destination is the setup journey step "Add Exomem to your assistant"

#### Scenario: Redemption from an app

- **WHEN** a person redeems an invitation while an OAuth continuation is live
- **THEN** the response returns the consent path

### Requirement: Not now and Keep it as it is end the request without a code

When an app opened the consent page, "Not now" and "Keep it as it is" SHALL end the OAuth request with `access_denied`, as a finished connection ends it. The decline route SHALL take its authority from the OAuth continuation cookie, SHALL check the same origin and a nonce, and SHALL consume the transaction once. It MUST redirect only to the redirect URI bound to the consumed transaction. Neither outcome SHALL write or revoke a grant or a code.

#### Scenario: Web app is declined

- **WHEN** a person chooses "Not now" for a web app and the transaction is live
- **THEN** the system consumes the transaction and returns the validated redirect URI with `error=access_denied` and the original `state`
- **AND** the page shows the declined state briefly, then navigates the top-level window to that address

#### Scenario: Loopback app is declined

- **WHEN** a person chooses "Not now" for an app whose redirect is a loopback address
- **THEN** the page sends the denial to the app in the background and stays on the declined state
- **AND** if the browser blocks that request, the page falls back to a top-level navigation

#### Scenario: Connected app is kept

- **WHEN** a person who already connected the app chooses "Keep it as it is"
- **THEN** the app receives `access_denied` and the existing grant stays unchanged

#### Scenario: Connect after all

- **WHEN** the declined state is shown for a web app
- **THEN** it offers a link to the app's connector settings page
- **AND** for a loopback app it offers no such action

#### Scenario: Request is stale, replayed or expired

- **WHEN** the confirmation is stale, the nonce is wrong, or the transaction was already used or expired
- **THEN** the system answers 409 with the current consent path, 400, or 410, and redirects nowhere

#### Scenario: Request comes from another origin

- **WHEN** a decline request comes from a different origin
- **THEN** the system rejects it before it touches the transaction

### Requirement: Owners list and disconnect connected apps

A signed-in owner SHALL be able to list connected apps and disconnect each one. The list MUST show a display name taken from client metadata, else the platform label, else the host. It MUST NOT include first-party clients. Disconnect SHALL revoke the app's grant, token families, access tokens and unconsumed codes, limited to the session's user and tenant.

#### Scenario: Owner lists apps

- **WHEN** an owner opens the app list
- **THEN** each app shows its display name, platform, kind (web or local), first connected time and last authorized time
- **AND** the first-party Home client is absent

#### Scenario: Owner disconnects an app

- **WHEN** an owner disconnects one of their apps with a valid session and CSRF value
- **THEN** the grant and its tokens and codes are revoked and the system answers 200
- **AND** repeating the request also answers 200

#### Scenario: Owner names another tenant's app

- **WHEN** a request names an unknown id or an app of another tenant
- **THEN** the system answers 404 and changes nothing

### Requirement: Reviewers sign in on the web

The reviewer sign-in route SHALL accept a username and password without an OAuth nonce, apply the same rate limits and constant-work password check as the app path, create an Exomem web session and send the reviewer to Home. Every failure MUST return the same 401. A request with a nonce SHALL keep the app path.

#### Scenario: Valid reviewer credential on the web

- **WHEN** a reviewer posts a valid unexpired credential without a nonce
- **THEN** the system creates a web session and returns Home as the destination

#### Scenario: Reviewer credential fails

- **WHEN** the username is unknown, the password is wrong, or the credential is expired or revoked
- **THEN** the system returns one identical 401 without saying which part failed

#### Scenario: Reviewer signs in from an app

- **WHEN** the request carries a nonce
- **THEN** the system follows the existing app path unchanged

### Requirement: Friend invitations name the inviter and carry the friend price

An operator SHALL be able to issue an invitation of kind `standard`, `friend` or `covered`. A friend invitation SHALL carry an inviter name (up to 60 characters), an optional note (up to 280 characters) and the inviter's email. A covered invitation SHALL grant complimentary access with no checkout. The inspect route SHALL return the invitation facts for a bearer token and SHALL render names and notes as plain text. All unusable tokens MUST get one identical answer.

#### Scenario: New person inspects a friend invitation

- **WHEN** a bearer token for a usable friend invitation is inspected
- **THEN** the answer carries the kind, the bound email, the expiry, the inviter's name, the note, and the usual and friend prices
- **AND** the answer never carries the discount id

#### Scenario: Price cannot be read

- **WHEN** the price preview from the payment provider fails
- **THEN** the price field is unknown with the reason `price_unavailable` and no number is shown

#### Scenario: Token is unusable

- **WHEN** the token is expired, used, revoked or unknown
- **THEN** the system answers one identical 404 that does not say which

#### Scenario: Existing owner presents an invitation

- **WHEN** the bound email already owns a live tenant
- **THEN** the answer says the owner exists and whether the caller is signed in
- **AND** the system mints no session from the token

#### Scenario: Inspect is rate limited

- **WHEN** one network address inspects more than the allowed number of tokens in ten minutes
- **THEN** the system refuses further requests from that address

### Requirement: An existing owner chooses the friend price or keeps their plan

A signed-in owner whose email equals the invitation's email SHALL choose `use_friend_price` or `keep_plan`. The system MUST NOT change a paying owner's plan without that choice. A covered or standard invitation to a paying owner SHALL allow `keep_plan` only. The system SHALL record the decision once and return it on repeat.

#### Scenario: Owner takes the friend price

- **WHEN** an owner with a live subscription chooses `use_friend_price` on a friend invitation
- **THEN** the system applies the discount to the subscription from the next billing period, then consumes the invitation and records the decision
- **AND** it answers 200 `applied` with the next payment time

#### Scenario: Subscription already ended

- **WHEN** the owner's subscription has ended and they choose `use_friend_price`
- **THEN** the system records the offer on the tenant and answers 200 `applied_on_resubscribe`

#### Scenario: Owner keeps their plan

- **WHEN** an owner chooses `keep_plan`
- **THEN** the system consumes the invitation, changes no billing, and answers 200 `kept`

#### Scenario: Payment provider fails

- **WHEN** the provider refuses or times out
- **THEN** the system answers 503 and leaves the invitation unconsumed

#### Scenario: Session email differs

- **WHEN** the session's email differs from the invitation's email
- **THEN** the system refuses the decision and changes nothing
