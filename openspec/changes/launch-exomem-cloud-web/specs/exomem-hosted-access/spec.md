## RENAMED Requirements

- FROM: `### Requirement: Exomem access is invite only during alpha`
- TO: `### Requirement: Exomem access starts with an email, an invitation or a waitlist place`

## MODIFIED Requirements

### Requirement: Exomem access starts with an email, an invitation or a waitlist place

Access SHALL start in one of three ways: a start request, an operator invitation, or a waitlist place. Only an authenticated operator SHALL create a complimentary, covered, friend or paid operator invitation. The public start form SHALL create only paid self-serve start links. Each invitation MUST be bound to one normalized email address, an entitlement source, an expiry and one high-entropy token. The system MUST store the token's digest, not the plaintext.

#### Scenario: Operator creates a complimentary invite

- **WHEN** an operator with valid Exomem invite authority creates an unexpired complimentary invite for an email address while Cloud has a free place
- **THEN** the system stores a single-use digest-bound invite, counts it against Cloud capacity, and returns or delivers one redemption URL
- **AND** the plaintext token is not written to logs or retained in the database

#### Scenario: Operator creates a paid invitation

- **WHEN** an authorized operator creates a paid invitation while Cloud has a free place
- **THEN** the system stores and delivers one operator-authorized Paddle invitation and counts it against Cloud capacity
- **AND** the browser cannot substitute the Paddle product, price, environment, or public admission path

#### Scenario: Invitation delivery fails or expires

- **WHEN** a paid invitation is not delivered, expires, or is revoked before redemption
- **THEN** it no longer counts against Cloud capacity
- **AND** its record remains available for audit

#### Scenario: Public caller attempts to create an invite

- **WHEN** a caller without operator authority invokes the invite creation boundary
- **THEN** the system rejects the request without revealing invite, capacity or account state

#### Scenario: Start form never creates a free invitation

- **WHEN** anyone submits the start form
- **THEN** the system creates at most a paid self-serve start link or a waitlist entry
- **AND** it never creates a complimentary, covered or friend invitation

### Requirement: Existing users can request a non-enumerating sign-in link

An identity that already owns an Exomem tenant SHALL be able to request a short-lived, single-use sign-in link by email. The start form SHALL answer every request that passes the challenge with the same 202 acknowledgement, cookie policy and minimum response time. That includes five outcomes: a malformed address, an address-limited request, an existing owner, a new address with a free place, a new address when Cloud is full. A common browser or network retry signal MAY vary with that public limiter; it MUST NOT vary with address eligibility or address-specific suppression. A start request MUST NOT create an account or tenant.

#### Scenario: Existing Exomem owner requests a link

- **WHEN** an existing owner submits their normalized email with a valid challenge token within rate limits
- **THEN** the system queues a sign-in link email and returns the generic acknowledgement

#### Scenario: Unknown address requests a link

- **WHEN** an address with no Exomem tenant submits the same request
- **THEN** the system returns the same acknowledgement, with a byte-identical `Set-Cookie`, and creates no identity, tenant or entitlement
- **AND** the response takes at least as long as the minimum response time

#### Scenario: Repeat requests and waitlist mode

- **WHEN** a waiting person asks again, a person with a live start link asks again, or the setting is `waitlist` and a place is free
- **THEN** the acknowledgement, the cookie and the minimum response time are the same as for every other outcome

#### Scenario: Request is rate limited or malformed

- **WHEN** the address is malformed, or the network or the address exceeds its hourly limit
- **THEN** the system returns the same acknowledgement as for an accepted request and sends nothing

### Requirement: Invitation and sign-in surfaces preserve account privacy

Public access responses and operational logs MUST NOT reveal whether an email has an account, and MUST NOT include invite tokens, sign-in tokens, session secrets, cell credentials, or raw email where an opaque reference suffices. One response MAY say that the bound email already owns an account: the invitation inspect response, which only the holder of a valid invitation token can read.

#### Scenario: Sensitive access sentinel reaches an error path

- **WHEN** an invite, sign-in, or session operation fails while carrying a sensitive sentinel
- **THEN** application logs and returned diagnostics omit the token or secret
- **AND** public responses disclose no additional account-existence information

#### Scenario: Holder inspects an invitation for an existing owner

- **WHEN** the holder of a valid invitation token inspects it and the bound email already owns a tenant
- **THEN** the response says that the owner exists
- **AND** no other public response says whether an email has an account

### Requirement: Successful onboarding reaches a useful memory flow

After valid redemption, the system SHALL show deterministic provisioning progress and SHALL lead a ready tenant through the setup journey: add Exomem to an assistant, finish in that app, and see the connection. The journey MUST NOT require local installation, GitHub, Markdown, vault paths, or billing details for a complimentary invite.

#### Scenario: Cell becomes ready normally

- **WHEN** an invited user's cell reaches ready state within the target window
- **THEN** the setup step offers "Add Exomem to your assistant" with the tenant's Cloud connector address
- **AND** the user can complete it without encountering infrastructure or schema terminology

#### Scenario: Provisioning is delayed

- **WHEN** the cell is not yet ready
- **THEN** the page shows a content-free progress state, refreshes automatically, and shows the support reference
- **AND** it does not accept a write that could be lost or routed elsewhere

## ADDED Requirements

### Requirement: Public policies describe paid admission and bot protection

The Terms SHALL describe monthly subscriptions, paid and covered invitations, waitlist admission and eligibility at age 18 or older. They SHALL preserve export, deletion and mandatory consumer rights. Eligibility MUST NOT add a date-of-birth or identity check. The privacy policy SHALL name Brevo transactional email and Cloudflare Turnstile, including its technical signals and processor/controller roles.

#### Scenario: Visitor reads the policies before admission opens

- **WHEN** a visitor reads the Terms and privacy policy
- **THEN** they describe the paid service and waitlist without claiming invitation-only alpha access

### Requirement: The start form is protected by a Turnstile challenge

The start form SHALL check every request with a Cloudflare Turnstile challenge. The form MUST fail closed only when the service reports a token error (`missing-input-response`, `invalid-input-response` or `timeout-or-duplicate`), or when the verified hostname or action differs from the expected one. For every other failure, the form SHALL fall back to the rate limits and the server SHALL log an error. The former sign-in link route SHALL use the same handler.

#### Scenario: Challenge token is missing, invalid or reused

- **WHEN** the request carries a missing, invalid or already used challenge token
- **THEN** the system answers 400 `challenge_failed` before it reads the email

#### Scenario: Hostname differs

- **WHEN** the service verifies the token but reports a hostname other than the public host
- **THEN** the system answers 400 `challenge_failed`

#### Scenario: Action differs

- **WHEN** the service verifies the token but reports an action other than `start`
- **THEN** the system answers 400 `challenge_failed`

#### Scenario: The check cannot run

- **WHEN** the service answers 408, 429 or a 5xx status, the request fails in transport, the service reports `internal-error`, the secret is missing or rejected, or a test secret runs in production
- **THEN** the request continues under the per-address and per-network rate limits
- **AND** the server logs an error

#### Scenario: Former sign-in route is called

- **WHEN** a caller posts to the former sign-in link route
- **THEN** the same challenge, rate limits and minimum response time apply

### Requirement: The admission setting decides what a new address receives

The setting `EXOMEM_SELF_SERVE_ADMISSION` (`waitlist` or `open`) SHALL decide what an address with no tenant receives from the start form. The default and any unknown value are `waitlist`.

#### Scenario: Admission is open and a place is free

- **WHEN** the setting is `open`, Cloud has a free place, nobody waits, and a new address submits the start form
- **THEN** the system creates a start link that expires 48 hours after creation
- **AND** it queues one start email for that address

#### Scenario: Admission is open and Cloud is full

- **WHEN** the setting is `open` and Cloud has no free place, or someone waits, and a new address submits the start form
- **THEN** the system adds the address to the waitlist and queues the waitlist email
- **AND** it creates no start link

#### Scenario: Admission is waitlist only

- **WHEN** the setting is `waitlist` and a new address submits the start form
- **THEN** the system adds the address to the waitlist even when Cloud has a free place

### Requirement: Waitlisted people are admitted first come, first served

While the setting is `open`, the system SHALL admit waiting people in the order they joined, one for each free Cloud place, and SHALL skip an address that already owns an active account. A new address MUST NOT pass a person who waits. A person who asks again while waiting SHALL keep their place and MUST NOT receive a second waitlist email. A person whose start link was used or lapsed SHALL join the back of the queue when they ask again. The system MUST NOT reveal a queue position.

#### Scenario: A place opens

- **WHEN** a Cloud place becomes free and people wait
- **THEN** the system creates a start link for the oldest waiting person, marks them admitted and queues the place-opened email
- **AND** each admission commits in its own transaction under the capacity lock

#### Scenario: Newcomer arrives while people wait

- **WHEN** Cloud has a free place, someone already waits, and a new address submits the start form
- **THEN** the new address joins the back of the waitlist

#### Scenario: Waiting person asks again

- **WHEN** a person who still waits submits the start form again
- **THEN** their entry keeps its place, no second entry exists, and no second waitlist email is sent

#### Scenario: Waiting address already owns an account

- **WHEN** the oldest waiting address already owns an active account
- **THEN** promotion skips it and admits the next waiting person

#### Scenario: Start link lapsed or was used

- **WHEN** a person's start link lapsed unused, or was used and the tenant was later deleted, and they submit the start form again
- **THEN** they join the back of the queue

#### Scenario: Promotion runs twice at once

- **WHEN** two promotion runs overlap with one free place
- **THEN** exactly one person is admitted

#### Scenario: Capacity observations are stale

- **WHEN** Cloud capacity observations are stale
- **THEN** the system admits nobody and queues new addresses

### Requirement: A person's start links share one place

When the system reissues a start link for the same person, it SHALL keep the original expiry and SHALL leave earlier unconsumed links valid until they expire. Redeeming one start link SHALL revoke the person's other links.

#### Scenario: Person with a live start link asks again

- **WHEN** a person who holds a live start link submits the start form again
- **THEN** the system sends a fresh start link with the same expiry, and the earlier unconsumed links stay valid until they expire
- **AND** no one else can cancel or move that person's place

#### Scenario: One start link is redeemed

- **WHEN** a person redeems one of several start links issued to them
- **THEN** the system revokes the others

### Requirement: Invitation and hold emails are sent once

Every Exomem email SHALL go through the email outbox. The system MUST enqueue each email in the same transaction as the fact that causes it, under a unique dedupe key. Delivery SHALL be at least once under a lease and SHALL retry until the email's own expiry. Each kind MUST re-check its precondition when claimed and cancel if it no longer holds. Each time limit SHALL render at send time in the recipient's zone, or labelled UTC when the zone is unknown.

#### Scenario: The same fact is recorded twice

- **WHEN** a retry records the same causing fact twice
- **THEN** one outbox row and one email exist for that dedupe key

#### Scenario: Email provider is down for hours

- **WHEN** the email provider fails and recovers before a start link expires
- **THEN** the system delivers the start email and the person keeps their place
- **AND** after the link's own expiry the system stops retrying

#### Scenario: Precondition no longer holds

- **WHEN** the system claims a reminder after the person has already used the invitation
- **THEN** the row becomes cancelled and no email is sent

#### Scenario: Invitee reminder

- **WHEN** an operator issues a friend invitation that lasts longer than three days
- **THEN** the system queues a reminder for three days before the invitation expires, with the token encrypted in the payload
- **AND** it sends the reminder only while the invitation is still usable

#### Scenario: Inviter notices

- **WHEN** a friend invitation that has an inviter email is used
- **THEN** the system queues "used" to the inviter inside the consuming transaction
- **AND** when the invitation expires unused, the system sends "ended unused" to the inviter

#### Scenario: Hold reminder

- **WHEN** a person who has not paid redeems an invitation and the system stops the cell
- **THEN** the system queues the hold reminder for five days after that cell's creation
- **AND** it cancels the reminder if the cell no longer stops or the tenant has paid
- **AND** it names the inviter from the invitation when it sends the reminder, so a name that the inviter's account deletion removed is never sent

#### Scenario: Recipient's account has a time zone

- **WHEN** the system sends an invitation email or an inviter notice to an address whose Exomem account has a stored time zone
- **THEN** the email shows its dates in that time zone, read when the email is sent

#### Scenario: Recipient time zone is unknown

- **WHEN** the system renders a time limit for a recipient with no stored time zone
- **THEN** the time shows in UTC with the label

### Requirement: Email and waitlist data are kept for a limited time

The system SHALL remove the recipient and the payload of each settled outbox row 30 days after it settles. It SHALL delete a waitlist entry 180 days after the later of the person's last request and the expiry of the entry's last start link, unless the address owns an account. Deleting an account SHALL scrub its outbox rows, and the inviter name, inviter email and note of each invitation that the account asked for. The privacy page SHALL state these periods.

#### Scenario: Settled email ages

- **WHEN** an outbox row settled more than 30 days ago
- **THEN** the row keeps no recipient and no payload

#### Scenario: Waitlist entry ages

- **WHEN** a waiting person made no request for 180 days and holds no live start link
- **THEN** the system deletes the entry

#### Scenario: Admitted entry whose link lapsed

- **WHEN** a person was admitted, their last start link expired 180 days ago, and the address owns no account
- **THEN** the system deletes the entry

#### Scenario: Address owns an account

- **WHEN** an entry's address owns an account
- **THEN** the 180-day deletion does not apply to that entry

#### Scenario: Account is deleted

- **WHEN** an account deletion finishes
- **THEN** no outbox row keeps that account's recipient or payload

#### Scenario: Privacy page states the periods

- **WHEN** a person reads the privacy page
- **THEN** it states the outbox period of 30 days and that a waitlist entry is deleted 180 days after the later of the last request and the last link's expiry

### Requirement: Account lifecycle emails are sent once with their fact

The system SHALL send emails 03 to 07 through the email outbox, each under a dedupe key that names the one fact it announces, so that each fact sends at most one email. Each email SHALL re-check its fact when the outbox claims it, and the system SHALL cancel the email when the fact no longer holds. Each row SHALL name the tenant it belongs to. Emails 03 to 06 SHALL go to the owner's address and time zone at send time.

- 03 "Your Exomem is ready": the first time a cell is ready and running. The cell controller records readiness, so a bounded pass of the outbox finds these cells. Marketplace reviewer tenants SHALL never receive it. A cell that showed a start when email 03 shipped (ready, or observed running or read-only) SHALL never receive it.
- 04 "Your payment didn't go through": in the statement that moves a subscription into past due.
- 05 "Your Exomem subscription has ended": in the transaction that claims the cancellation notice of a cancelled, read-only cell.
- 06, the deletion reminder: queued with email 05 for seven days before the kept-until date, only while more than seven days are left. When the kept-until date moves later, email 06 SHALL wait until seven days before the new date.
- 07 "Your Exomem has been deleted": queued by the one transaction that deletes the Exomem when its kept window ends, or by the account deletion finish after it scrubs the account's other emails. It goes to the owner's address at deletion and SHALL be sent only after the cell controller reports every cell of the tenant deleted. Its deletion date SHALL be the date when the cell controller reported the last cell of the tenant deleted.

The row of email 07 SHALL keep the owner's address and time zone only until 30 days after it settles, and its encrypted payload only until it settles.

#### Scenario: A cell is ready for the first time

- **WHEN** the cell of a tenant that is not a marketplace reviewer is ready and running for the first time
- **THEN** the system queues one email 03 for the owner
- **AND** a later restart of the same cell queues no other email 03

#### Scenario: A cell started before email 03 existed

- **WHEN** a cell that was ready, or observed running or read-only, when email 03 shipped becomes ready again
- **THEN** the system queues no email 03

#### Scenario: The owner changes address before an email is sent

- **WHEN** the owner's address changes after email 03, 04, 05 or 06 is queued
- **THEN** the email goes to the new address

#### Scenario: Payment recovers before the email is sent

- **WHEN** the subscription leaves past due before the outbox sends email 04
- **THEN** the system cancels email 04

#### Scenario: Owner resubscribes inside the kept window

- **WHEN** the owner resubscribes before the outbox sends email 05 or 06
- **THEN** the system cancels both emails
- **AND** a later cancellation queues new ones

#### Scenario: The cell is not yet deleted

- **WHEN** the tenant is deleted but the cell controller has not yet reported its cell deleted
- **THEN** email 07 waits, with no deadline, and the wait counts no delivery attempt
- **AND** once the controller reports the cell deleted, email 07 goes out with the date of that report
- **AND** a re-admission or a later deletion cancels it

#### Scenario: Account deletion finishes

- **WHEN** the account deletion finish scrubs every outbox row of the tenant and of the owner's address
- **THEN** the owner still receives email 07
- **AND** 30 days after it is sent, its row keeps no address, time zone or payload

### Requirement: Start and redemption record the person's time zone

The start form and the redemption routes SHALL accept an optional IANA time zone name. The system SHALL validate it with `Intl.DateTimeFormat`. A start request SHALL use a valid browser zone only as an email fallback when no stored account zone exists. It MUST NOT change the account, invitation or waitlist zone. Redemption SHALL store a valid zone or unknown.

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

### Requirement: Paid redemption admits a stopped cell that starts after payment

A complimentary redemption SHALL create a cell that runs. A paid redemption SHALL create the tenant, an entitlement that awaits its first payment, and a cell whose desired state is stopped and that holds its Cloud place. The system MUST NOT start that cell until a verified payment makes the entitlement active or trialing.

#### Scenario: Complimentary redemption

- **WHEN** a person redeems a complimentary invitation
- **THEN** the system creates a cell whose desired state is running

#### Scenario: Paid redemption

- **WHEN** a person redeems a paid invitation
- **THEN** the system creates the tenant, an entitlement that awaits its first payment, and a stopped cell
- **AND** no runtime starts for that cell

#### Scenario: Verified payment arrives

- **WHEN** a verified subscription event makes the entitlement active or trialing
- **THEN** the cell's desired state becomes running

### Requirement: Not now and Keep it as it is end the request without a code

When an app opened the consent page, "Not now" and "Keep it as it is" SHALL end the OAuth request with `access_denied`, as a finished connection ends it. The decline route SHALL take its authority from the OAuth continuation cookie, SHALL check the same origin and a nonce, and SHALL consume the transaction once. It MUST redirect only to the redirect URI bound to the consumed transaction. Neither outcome SHALL write or revoke a grant or a code.

#### Scenario: Web app is declined

- **WHEN** a person chooses "Not now" for a web app and the transaction is live
- **THEN** the system consumes the transaction and returns the validated redirect URI with `error=access_denied` and the original `state`
- **AND** the page navigates the top-level window to that address after showing the declined or kept state for at most 3 seconds

#### Scenario: Loopback app is declined

- **WHEN** a person chooses "Not now" for an app whose redirect is a loopback address
- **THEN** the page sends the denial to the app in the background and stays on the declined state
- **AND** if the browser blocks that request, the page falls back to a top-level navigation

#### Scenario: Connected app is kept

- **WHEN** a person who already connected the app chooses "Keep it as it is"
- **THEN** the app receives `access_denied` and the existing grant stays unchanged

#### Scenario: Connect after all

- **WHEN** the declined state is shown for a web app
- **THEN** it offers a link to the app's connector settings page when one is configured for the platform, and otherwise no action
- **AND** for a loopback app it offers no such action

#### Scenario: Request is stale, replayed or expired

- **WHEN** the confirmation is stale, the nonce is wrong, or the transaction was already used or expired
- **THEN** the system answers 409 with the current consent path, 400, or 410, and redirects nowhere

#### Scenario: Request comes from another origin

- **WHEN** a decline request comes from a different origin
- **THEN** the system rejects it before it touches the transaction

### Requirement: The consent page shows where the code goes

The consent page SHALL always show where the authorization code goes: the host of the redirect address, or "this computer" when the redirect is a loopback address. A web request footer SHALL show only the redirect host. A loopback footer SHALL show the app name and "this computer". Before requesting consent, the page SHALL label an unverified web client name as app-supplied beside the requested permissions. The system MUST store a client name only when the client declares one.

#### Scenario: Web client declares a name

- **WHEN** a web client with a declared name opens the consent page
- **THEN** the footer shows the redirect host and the permissions show the declared name labelled as app-supplied

#### Scenario: Loopback client declares a name

- **WHEN** a client with a loopback redirect and a declared name opens the consent page
- **THEN** the footer shows the declared app name and "this computer"

#### Scenario: Expired request navigation

- **WHEN** a connection request expires
- **THEN** the short expiry message is vertically centered and the wordmark links to the landing page when no signed-in account is known
- **AND** live signed-in journey steps link the wordmark to Home

#### Scenario: Recognizable platform tile

- **WHEN** a known web platform opens a journey
- **THEN** its tile shows a generic icon with the platform name instead of an unexplained initial

#### Scenario: Client declares no name

- **WHEN** a client declares no name
- **THEN** the system stores no name, and the page shows the destination with the platform label when one exists

### Requirement: Owners list and disconnect connected apps

A signed-in owner SHALL be able to list connected apps and disconnect each one. The list MUST show the name the client declared, else the platform label, else the host. Beside a declared name, it SHALL show the redirect host and label the name as the client's own claim. It MUST NOT include first-party clients. Disconnect SHALL revoke the app's grant, token families, access tokens and unconsumed codes, limited to the session's user and tenant.

#### Scenario: Owner lists apps

- **WHEN** an owner opens the app list
- **THEN** each app shows its display name, platform, kind (web or local), context (coding or conversation), first connected time and last authorized time
- **AND** a client-declared name shows the redirect host beside it, labelled as the client's own claim
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

An operator SHALL be able to issue an invitation of kind `standard`, `friend` or `covered`. A friend invitation SHALL carry an inviter name (up to 60 characters), an optional note (up to 280 characters) and an optional inviter email. A covered invitation SHALL carry the name of the person who covers it and SHALL grant complimentary access with no checkout. An inviter email SHALL require the invitee's name, which the inviter's notices use. Invitees SHALL see names and notes as plain text.

#### Scenario: Operator issues a friend invitation

- **WHEN** an operator issues a friend invitation with an inviter name, a note and an inviter email
- **THEN** the system stores them with the invitation and delivers one redemption URL

#### Scenario: Inviter email is absent

- **WHEN** an operator issues a friend invitation without an inviter email
- **THEN** the invitation is valid and the inviter receives no notice

#### Scenario: Covered invitation

- **WHEN** an operator issues a covered invitation
- **THEN** the entitlement source is complimentary and the invitee sees no checkout

### Requirement: Inspecting an invitation shows only what its holder needs

The inspect route SHALL take a bearer token and return the invitation's kind, bound email, expiry, inviter name, note and prices. All unusable tokens MUST get one identical 404. The route SHALL rate limit each network address. A token presented by an existing owner MUST NOT sign that owner in.

#### Scenario: New person inspects a friend invitation

- **WHEN** a bearer token for a usable friend invitation is inspected
- **THEN** the answer carries the kind, bound email, expiry, inviter name, note, and the usual and friend prices
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
- **AND** the answer carries the prices only when the caller is signed in as that owner
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

#### Scenario: Owner on another price

- **WHEN** an owner's live subscription is on a price other than the base price that the friend discount is restricted to, or its price was never reported
- **THEN** inspect shows the friend price as unknown with the reason `plan_price_differs` or `plan_price_unknown`
- **AND** the decision accepts only `keep_plan` and does not call Paddle

#### Scenario: Subscription already ended

- **WHEN** the owner's subscription has ended and they choose `use_friend_price`
- **THEN** the system records the offer on the tenant and answers 200 `applied_on_resubscribe`

#### Scenario: Owner keeps their plan

- **WHEN** an owner chooses `keep_plan`
- **THEN** the system consumes the invitation, changes no billing, and answers 200 `kept`

#### Scenario: Paddle reports the friend discount first

- **WHEN** the newest subscription event that the system applies, from a webhook or from reconciliation, shows the configured friend discount and the tenant holds no friend offer
- **THEN** the system records the offer of a friend invitation addressed to the owner in the same transaction, so a later resubscribe keeps the friend price
- **AND** an older event that arrives late records nothing

#### Scenario: An earlier answer reached Paddle

- **WHEN** an owner's `use_friend_price` reached Paddle but its answer was lost, and the owner then chooses `keep_plan`
- **THEN** the system checks the stored subscription facts, and reads the subscription at Paddle when they do not show the friend discount, before it stores a decision
- **AND** because the subscription carries the friend discount, it records `applied` and the friend offer, and answers 200 `applied`
- **AND** a friend offer that the tenant holds never stands in for that check

#### Scenario: Owner already holds the friend price through another invitation

- **WHEN** an owner who took the friend price through one invitation, at signup or by answering it, opens another friend invitation, whether the friend price is on the subscription or is the offer that the next checkout applies
- **THEN** inspect shows the friend price as unknown with the reason `friend_price_taken`, because an Exomem has one friend price
- **AND** the decision accepts only `keep_plan` and does not call Paddle, so the tenant keeps the friend offer it has and the other inviter gets no email
- **AND** `keep_plan` records `kept` for that invitation
- **AND** an offer that the tenant holds from an invitation the owner never used does not count, so an answer whose update reached Paddle still records `applied`

#### Scenario: Friend discount is not configured

- **WHEN** an owner chooses `keep_plan` on a friend invitation for a live subscription and no friend discount is configured
- **THEN** the system answers 503 with `FRIEND_PRICE_UNAVAILABLE` and leaves the invitation unconsumed, because nothing can show the discount absent

#### Scenario: Payment provider fails

- **WHEN** the provider refuses or times out
- **THEN** the system answers 503 and leaves the invitation unconsumed

#### Scenario: Friend discount fails verification

- **WHEN** the configured friend discount fails its checks before the subscription update
- **THEN** the system refuses the decision with a stable error, makes no update and leaves the invitation unconsumed

#### Scenario: Session email differs

- **WHEN** the session's email differs from the invitation's email
- **THEN** the system refuses the decision and changes nothing

### Requirement: Sign-in recovery cannot authenticate or enumerate accounts

Owner authentication links SHALL remain single-use and expire after 15 minutes. A separate opaque recovery receipt SHALL bind resend recovery to the requesting browser. Its configured lifetime SHALL default to one hour. Recovery MUST NOT create a session, return an address, reveal account eligibility or recover another browser's request.

#### Scenario: A proven browser opens an expired or used link

- **WHEN** the browser presents a valid recovery binding for that request
- **THEN** the page can show the corresponding expired or used state and one resend action
- **AND** the action preserves uniform acknowledgement and address-specific suppression

#### Scenario: Recovery proof is absent or mismatched

- **WHEN** the browser cannot prove the recovery binding
- **THEN** the page shows the generic email form without disclosing the token outcome or bound address

#### Scenario: Recovery receipt reaches the authentication boundary

- **WHEN** a caller presents a recovery receipt instead of an authentication token
- **THEN** the authentication boundary refuses to create a session

### Requirement: Anonymous resend waits preserve address privacy

The server SHALL supply visible retry timing only from the common browser or network limiter. The response MUST NOT expose the address bucket, account membership or waitlist membership. The browser SHALL render the server timing rather than assume a fixed countdown.

#### Scenario: Different addresses share a limited browser or network

- **WHEN** requests differ only in their submitted address
- **THEN** they receive the same public retry policy for that browser or network
- **AND** suppression for one address does not create a distinct public state

### Requirement: Web flows follow the approved design states with real facts

The web experience SHALL use the approved rounds 41–47 components and states. Prices, dates, counts and lifecycle sentences MUST follow their runtime sources. Hidden transition panes SHALL be inert, and each page SHALL have one polite status region. Phone placement, navigation and recovery SHALL match the latest reference.

#### Scenario: A connection succeeds before its animation ends

- **WHEN** the server confirms the connection before the writing sequence finishes
- **THEN** navigation waits for the writing sequence and completion seal
- **AND** reduced motion uses the static treatment without claiming simulated backend progress

#### Scenario: The email form has no guidance to show

- **WHEN** the email field has no hint or error
- **THEN** the field-to-button gap is 20 px and no empty guidance row occupies space

#### Scenario: Subscription checkout completes before the service is ready

- **WHEN** Paddle reports completion but backend readiness is still pending
- **THEN** the page shows the drawn preparing state without claiming usable service
- **AND** it reaches ready only after the server reports the qualified lifecycle state

#### Scenario: An old payment frame emits a late event

- **WHEN** an event does not belong to the current bound transaction
- **THEN** it cannot change the current checkout or activate another account

#### Scenario: A flow changes its visible step

- **WHEN** the previous pane leaves and the new pane enters
- **THEN** hidden controls do not receive keyboard focus and the new step follows the reference's focus rule
- **AND** the transition does not duplicate payment or session effects

#### Scenario: A short phone window cannot fit the flow

- **WHEN** the viewport is shorter than the drawn content
- **THEN** the flow remains reachable by scrolling without horizontal overflow or decoration obscuring controls
