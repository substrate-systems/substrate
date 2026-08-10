## ADDED Requirements

### Requirement: The managed backup service is publicly named Endstate Cloud

Public copy SHALL name the managed encrypted backup service "Endstate Cloud",
across pricing, Terms, the account portal, the claim flow, transactional email,
page metadata, structured data, and the machine-readable text files under
`public/`. No public surface SHALL introduce the name "Hosted Backup", except
where a requirement below explicitly permits it.

The Endstate product itself SHALL NOT be renamed. Only the managed service is.

#### Scenario: Pricing presents the managed service tier

- **WHEN** the Endstate pricing section is rendered
- **THEN** the managed service tier is titled "Endstate Cloud"
- **AND** its call to action reads "Get Endstate Cloud — €4/mo" or
  "Get Endstate Cloud — €40/yr" according to the selected cadence
- **AND** the cadence control is labelled for assistive technology as
  "Endstate Cloud billing cadence"

#### Scenario: The account portal names the subscription

- **WHEN** a signed-in customer views the account portal
- **THEN** the page names their subscription "Endstate Cloud"
- **AND** when the stored plan value is an internal Paddle price identifier, the
  displayed plan name is "Endstate Cloud" rather than the identifier

#### Scenario: Claim email and claim page name the service

- **WHEN** a claim email is rendered, or the claim page is rendered for a valid
  token
- **THEN** the service is named "Endstate Cloud"

#### Scenario: The product name is untouched

- **WHEN** any public surface refers to the Windows setup and restore
  application
- **THEN** it is called "Endstate"

### Requirement: Terms bridges the previous service name once

The Terms page SHALL carry a "(previously Hosted Backup)" parenthetical on the
first use of "Endstate Cloud" in its definitions section, so a customer
reconciling an existing receipt can identify the service. No other public
surface SHALL carry that parenthetical.

#### Scenario: Definitions section bridges the rename

- **WHEN** the Terms page is rendered
- **THEN** its definitions section names the service "Endstate Cloud" followed
  by "(previously Hosted Backup)"

#### Scenario: Later Terms sections use the new name only

- **WHEN** the Terms subscription, acceptable use, privacy, and refund sections
  are rendered
- **THEN** each names the service "Endstate Cloud" without the parenthetical

### Requirement: Internal identifiers are retained and documented

The rename SHALL NOT change internal identifiers whose values are configuration
or contracts with something already in the field. The retained identifiers
SHALL include the `HOSTED_BACKUP` and `PADDLE_..._HOSTED_BACKUP...` environment
variables, the `src/lib/hosted-backup/` module path, the `/api/backups/*`
routes, the `HostedBackupCadence` type, the `openHostedBackupCheckout` function,
the `"paddle-hosted-backup"` call-to-action discriminant, the `hostedBackup`
capabilities key, database columns and enums, and the `hosted_backup` and
`supporter` analytics identifiers.

Each retention SHALL be recorded in `docs/naming.md` with the reason it is
retained.

#### Scenario: A retained identifier is documented

- **WHEN** an internal identifier keeps the "hosted backup" name
- **THEN** `docs/naming.md` lists that identifier and the reason it was not
  renamed

#### Scenario: Existing configuration keeps working

- **WHEN** the application is deployed with the environment variables that were
  configured before the rename
- **THEN** Endstate Cloud checkout, webhooks, storage quota, and the test-email
  bypass behave exactly as they did before

### Requirement: In-app navigation supports current and older desktop labels

Public copy SHALL instruct customers to open Endstate Cloud, the label displayed
by current desktop releases. Where purchase-code compatibility requires it, the
instruction MAY add that older releases show the section as Hosted Backup. The
previous name SHALL NOT be presented as the current service name.

#### Scenario: Claim email fallback names the real section

- **WHEN** a claim email is rendered
- **THEN** both its HTML and plaintext bodies instruct the reader to open
  "Endstate Cloud (shown as Hosted Backup in older versions)", choose "Use
  purchase code", and paste the code

#### Scenario: Claim page fallback names the real section

- **WHEN** the claim page renders its fallback step for a valid token
- **THEN** it instructs the reader to open "Endstate Cloud (shown as Hosted
  Backup in older versions)" and choose "Use purchase code"

### Requirement: Endstate Cloud copy does not weaken the Endstate Principles

Copy describing Endstate Cloud SHALL NOT state or imply that payment unlocks
local functionality, that the local product is limited, that Endstate can read
customer data, that self-hosting is unsupported, or that any platform other than
Windows is supported today. It SHALL NOT change any configured price.

#### Scenario: The tier describes a managed service, not an unlock

- **WHEN** the Endstate Cloud pricing tier is rendered
- **THEN** it states that data is encrypted before it leaves the machine, that
  keys are client-side and Endstate cannot read the data, that the self-hosting
  protocol stays open, and that the subscription can be cancelled at any time
- **AND** it does not state that any local capability requires payment

#### Scenario: Cloud backup claims stay within the proven boundary

- **WHEN** the Endstate Cloud tier is rendered
- **THEN** it is limited to Endstate application lists and supported non-secret
  settings, ready on another Windows PC
- **AND** it does not promise generic personal-file backup or automatic capture

#### Scenario: Platform claims stay accurate

- **WHEN** the Endstate software structured data is emitted
- **THEN** its `operatingSystem` value is "Windows"

#### Scenario: Prices are unchanged

- **WHEN** the pricing section is rendered
- **THEN** the Endstate Cloud prices are €4 per month and €40 per year
