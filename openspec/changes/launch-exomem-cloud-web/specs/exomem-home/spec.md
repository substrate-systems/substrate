## MODIFIED Requirements

### Requirement: Portability and account controls are understandable and safe

Home SHALL provide service status, billing source/status, sign-out, self-serve export and product-scoped deletion. Home SHALL NOT offer a control whose route cannot reach the tenant's cell. Destructive deletion MUST use a fresh single-use confirmation and distinguish queued work from completed destruction.

#### Scenario: Home offers no control that cannot reach the tenant's cell

- **WHEN** a ready Cloud tenant opens Home and uses every control on it
- **THEN** no request goes to a route that reaches only Hosted cells

#### Scenario: Owner requests export

- **WHEN** an owner wants a portable export
- **THEN** Home starts the self-serve export and does not tell the owner to ask support

#### Scenario: Owner starts deletion

- **WHEN** an owner initiates deletion
- **THEN** Home explains that Exomem data will be removed while unrelated products remain, sends a fresh confirmation, and does not delete on the first click

#### Scenario: Deletion is still destroying storage

- **WHEN** the cell is sealed but external destruction is pending
- **THEN** Home says deletion is in progress and offers no capture/recall surface

### Requirement: Exomem Home reflects service state honestly

The signed-in Home surface SHALL render one of preparing, awaiting-payment, ready, degraded, suspended, deletion-pending, or deleted states from authoritative control-plane data. It MUST NOT display the ready view before the tenant's cell passes readiness. Awaiting-payment SHALL come from the one shared definition of an entitlement that awaits its first payment.

#### Scenario: Tenant is provisioning

- **WHEN** the owner's cell is not yet ready
- **THEN** Home shows plain-language deterministic progress, polls a content-free status route, and exposes the support reference

#### Scenario: Tenant is awaiting payment

- **WHEN** the owner redeemed a paid invitation and the first payment is outstanding
- **THEN** Home says that the place is reserved and offers one Subscribe action
- **AND** Home does not show the ready view

#### Scenario: Tenant is ready

- **WHEN** the entitlement and the cell's readiness both permit service
- **THEN** Home presents connecting an assistant as the primary action, with the tenant's Cloud connector address

#### Scenario: Tenant is suspended

- **WHEN** manual or entitlement suspension is active
- **THEN** Home explains the available recovery and account actions, and never attempts to route around suspension

## ADDED Requirements

### Requirement: Export is a plain ZIP kept for a limited time

An export SHALL be a plain ZIP of Markdown files and attachments. The system SHALL keep it at the Cloud object store, with provider encryption, for `EXOMEM_EXPORT_TTL_HOURS` hours (default 24), then delete it. The privacy page SHALL describe the export in these terms.

#### Scenario: Export reaches its time limit

- **WHEN** a ready export passes its expiry
- **THEN** no object version of the archive remains and Home shows the export as expired

#### Scenario: Privacy page states the real handling

- **WHEN** an owner reads the privacy page
- **THEN** it says that an export is a plain ZIP kept at the object store with provider encryption until its expiry, and then deleted
- **AND** it does not say that the export is encrypted to a key only the owner holds

#### Scenario: Export fails

- **WHEN** the export job fails or passes its deadline
- **THEN** Home shows the failed state with its code and offers a new export

### Requirement: Owners start exports from Home

An owner SHALL start an export from Home while the tenant is not deleting and the cell is running, read-only or stopped and has run before. Home SHALL show one display state: none, packing, ready until a computed time, expired with the time it expired (none when a newer export replaced it), or failed with a code. A new export SHALL replace a ready one. The system SHALL allow three export requests in 24 hours.

#### Scenario: Owner exports a running account

- **WHEN** an owner of a running cell starts an export
- **THEN** Home shows packing, and then ready with the expiry computed in the reader's time zone

#### Scenario: Owner exports a stopped account

- **WHEN** an owner whose cell has run before and is now stopped starts an export
- **THEN** the export completes and the cell stays stopped

#### Scenario: Cell never held data

- **WHEN** an owner whose cell never ran starts an export
- **THEN** the system answers 409 `EXPORT_NO_DATA`

#### Scenario: Export is already open

- **WHEN** an owner starts an export while one is packing
- **THEN** the system answers 409 `EXPORT_IN_PROGRESS`

#### Scenario: Tenant is deleting

- **WHEN** an owner whose tenant is being deleted starts an export
- **THEN** the system answers 403 `EXPORT_UNAVAILABLE`

#### Scenario: Owner replaces a ready export

- **WHEN** an owner starts a new export while one is ready
- **THEN** Substrate marks the older export superseded in the same transaction, and Home shows it as expired at once
- **AND** the cell controller deletes its archive

#### Scenario: Owner exceeds the limit

- **WHEN** an owner starts a fourth export within 24 hours
- **THEN** the system answers 429

### Requirement: Export downloads start from Home and the ready email is sent once

The download link for an export SHALL come only from a Home request, and only while the export is ready and unexpired, checked on every read until the link is returned. Each link SHALL be an https URL, expire within five minutes, name only that export's object version, and be served as an attachment. Substrate MUST NOT send or log a link, and MUST NOT persist one anywhere but the export row. When an export becomes ready, the system SHALL send one email that links to Home.

#### Scenario: Owner downloads a ready export

- **WHEN** an owner asks for the link of a ready export
- **THEN** the system answers 200 with the link and its expiry, with `no-store` and `no-referrer` headers

#### Scenario: Link is not ready yet

- **WHEN** the cell controller has not finished the link
- **THEN** the system answers 202 `pending` and Home asks again

#### Scenario: Export fails while the request waits

- **WHEN** the export fails after the request and before the controller's link arrives
- **THEN** the system answers 409 `EXPORT_NOT_READY` and never returns the link

#### Scenario: Controller issues a link that is not https

- **WHEN** the controller's link is not an https URL
- **THEN** the system answers 502 `EXPORT_LINK_INVALID` and neither returns nor logs the link

#### Scenario: Export has expired

- **WHEN** an owner asks for the link after expiry
- **THEN** the system answers 410 `EXPORT_EXPIRED`

#### Scenario: Ready email

- **WHEN** an export becomes ready and the reconciliation runs twice
- **THEN** exactly one email is sent, and it links to Home

### Requirement: The export row says when assistants pause

When an export will stop a cell that serves assistants, which is a running or read-only cell, the export row on Home SHALL say that the assistants pause for a few minutes, before the owner starts and while the export packs. The row MUST NOT say so for a stopped cell.

#### Scenario: Running cell, no export yet

- **WHEN** the cell is running and no export exists
- **THEN** the row says that the assistants pause for a few minutes while the export packs

#### Scenario: Export packs on a cell that serves assistants

- **WHEN** the cell is running or read-only and the export is packing
- **THEN** the row says that the assistants are back in a few minutes and that an email follows when the export is ready

#### Scenario: Stopped cell

- **WHEN** the cell is stopped
- **THEN** the export row does not say that assistants pause

### Requirement: Levels on Home read and write the same store the assistant uses

Home SHALL show the level for each context (chat apps and coding agents) and SHALL let the owner change it. Home SHALL read and write the same preference as the assistant's `configure_memory` tool, for the owner audience. A write SHALL carry the revision it read, and the system SHALL refuse a stale revision with the current state. Home SHALL show an operator override and SHALL NOT overwrite it. When the cell is unavailable, Home SHALL say so and SHALL offer no switch.

#### Scenario: Owner sets a level on Home

- **WHEN** an owner sets chat apps to Light on Home
- **THEN** the assistant's next `configure_memory` read for the same tenant shows that level

#### Scenario: Assistant sets a level

- **WHEN** an assistant sets coding agents to Off
- **THEN** Home shows Off on its next load

#### Scenario: Stale revision

- **WHEN** a write carries an older revision than the stored one
- **THEN** the system answers 409 `PREFERENCE_CONFLICT` with the current state

#### Scenario: Cell is read-only

- **WHEN** the cell is read-only
- **THEN** a write answers 409 `CLOUD_CELL_READ_ONLY` and the switch is disabled

#### Scenario: Operator override

- **WHEN** an operator override is set for a context
- **THEN** Home shows the override and a write answers 409 `PREFERENCE_OPERATOR_OVERRIDE`

#### Scenario: Cell cannot answer

- **WHEN** the cell is stopped, not ready, unreachable or runs an older image
- **THEN** Home shows that the levels are unavailable with the reason and offers no switch

### Requirement: The live activity line is content free

Home SHALL show recent assistant activity as client family, action (recalled or saved), item count and time. The client family MUST be one of the cell's closed set of families, else unknown. The activity data MUST NOT contain note titles, paths, queries or content. Home SHALL read it on load, on tab focus and every 30 seconds while the tab is visible. When the activity is unavailable, Home SHALL show nothing in its place, and MUST NOT show zero.

#### Scenario: Assistant recalls notes

- **WHEN** an assistant recalls five notes
- **THEN** Home shows the client, "recalled", the count 5 and a time that updates in the browser

#### Scenario: Client is not a known family

- **WHEN** the cell names a client outside its set of client families
- **THEN** Home receives the event with an unknown client and never the cell's text

#### Scenario: Same client repeats an action

- **WHEN** one client takes the same action twice within 60 seconds
- **THEN** the two events appear as one

#### Scenario: Cell restarted

- **WHEN** the cell pod restarts
- **THEN** the event list is empty and its start time moves forward to the restart

#### Scenario: New account has no notes

- **WHEN** the note count is zero
- **THEN** Home says it waits for the first note

#### Scenario: Activity is unavailable

- **WHEN** the cell is stopped, not ready, unreachable or runs an older image
- **THEN** Home shows no activity line and no count

### Requirement: Home storage shows the real disk

Home SHALL show storage used and the filesystem size from the latest stored observation, with the observation time. It MUST NOT use a fixed plan allowance. When no observation exists, Home SHALL show storage as unknown with no bar.

#### Scenario: Observation exists

- **WHEN** the latest backup reported 1.2 GB used of a 10 GB filesystem
- **THEN** the bar shows 1.2 of 10 GB and the observation time

#### Scenario: Cell was never measured

- **WHEN** no report exists
- **THEN** Home shows storage as unknown and draws no bar

### Requirement: Home shows plan and dates from stored data

Home SHALL show the plan name, the next payment date, the next payment amount, the read-only end date, the kept-until date, a reviewer's access end date and whether the friend price applies. Each fact MUST come from stored data, except the next payment amount, which the system SHALL read from Paddle's preview of the subscription's next transaction and SHALL cache for at most 10 minutes per subscription. Each date SHALL render in the reader's time zone. A fact that the system cannot know MUST show as unknown with a reason, never as zero or an invented value.

#### Scenario: Paying owner

- **WHEN** a subscribed owner opens Home
- **THEN** the plan name is the stored Paddle price name and the next payment date is the stored next billing date

#### Scenario: Complimentary owner

- **WHEN** an owner has complimentary access
- **THEN** the next payment is unknown with the reason `complimentary`

#### Scenario: Next payment amount

- **WHEN** a subscribed owner opens Home
- **THEN** the next payment amount is the grand total of Paddle's next transaction for that subscription, so a friend price or an older price shows its own amount
- **AND** the amount is unknown with the reason `unavailable` when Paddle does not answer, and never a preview of the base price

#### Scenario: Payment failed

- **WHEN** an owner's payment failed and the dunning window is configured
- **THEN** read-only access ends on the grace start plus the configured dunning days

#### Scenario: Grace start is unknown

- **WHEN** an owner is past due and the grace start is unknown
- **THEN** the read-only end date is unknown with the reason `grace_start_unknown`

#### Scenario: Dunning window is not configured

- **WHEN** no dunning window is configured
- **THEN** the read-only end date is unknown with the reason `dunning_window_unconfigured`

#### Scenario: Friend price applies

- **WHEN** the provider-reported discount equals the configured friend discount
- **THEN** Home shows the friend price as applied, with the inviter's name

#### Scenario: Reviewer opens Home

- **WHEN** a reviewer opens Home
- **THEN** it shows the credential's end date and no billing

### Requirement: Every account has a support reference

The system SHALL give each tenant a unique support reference of 4 to 8 Crockford base-32 characters. Home SHALL show it as `EX-` followed by the reference. The reference MUST be stored on the tenant and MUST NOT change.

#### Scenario: New tenant

- **WHEN** a tenant is created
- **THEN** it receives a unique support reference without a person choosing it

#### Scenario: Trouble state

- **WHEN** Home shows a service problem
- **THEN** it shows the support reference with a way to copy it

### Requirement: The web journey learns a connection by polling

The setup step SHALL poll the connected-app list every 3 seconds for the first 10 minutes. It SHALL move to "joined" when an app has a last-authorized time later than the server time of the first poll, and SHALL name that app. After 10 minutes it SHALL keep waiting and poll every 30 seconds. The first-party Home client MUST NOT trigger it.

#### Scenario: App connects while the page waits

- **WHEN** an app connects after the first poll
- **THEN** the page moves to "joined" and names the app

#### Scenario: App was connected before the page opened

- **WHEN** an app's last-authorized time is earlier than the first poll's server time
- **THEN** the page keeps waiting

#### Scenario: Nothing connects for 10 minutes

- **WHEN** 10 minutes pass with no new connection
- **THEN** the page keeps waiting with no new element and polls every 30 seconds
