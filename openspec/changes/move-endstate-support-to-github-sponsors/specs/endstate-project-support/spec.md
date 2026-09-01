## ADDED Requirements

### Requirement: Voluntary support is taken through GitHub Sponsors as one-time contributions

Voluntary contributions to Endstate SHALL be taken through the GitHub Sponsors
profile for the `substrate-systems` organisation. The offered amounts SHALL be
$10 (Supporter), $29 (Founding Supporter), and $89 (Patron), each linking to a
one-time sponsorship at that amount. No recurring sponsorship tier SHALL be
offered, and no checkout operated by Substrate SHALL take a contribution.

#### Scenario: A tier links at its own one-time amount

- **WHEN** the Support Endstate section is rendered with the Sponsors profile live
- **THEN** each tier's action targets
  `https://github.com/sponsors/substrate-systems` with a one-time frequency and
  that tier's amount
- **AND** the link opens in a new tab without granting the opened page access to
  the opener

#### Scenario: The entry amount is the lowest tier

- **WHEN** the Support Endstate pricing card on the Endstate page is rendered
- **THEN** it shows "from $10"
- **AND** its call to action leads to the supporters page rather than opening a
  checkout in the pricing grid

### Requirement: The support surface degrades honestly until the Sponsors profile is live

A single constant SHALL gate the Sponsors links. While it is false the tier
cards SHALL still render their eyebrow, name, amount, and description, and the
action SHALL be replaced by one line stating that support is moving to GitHub
Sponsors. No link to the Sponsors profile SHALL be rendered while the constant
is false.

#### Scenario: The interim state offers no dead link

- **GIVEN** the Sponsors profile is not yet approved
- **WHEN** the Support Endstate section is rendered
- **THEN** every tier card shows its name, amount, and description
- **AND** the card states that support is moving to GitHub Sponsors, live within
  days
- **AND** the page contains no link to the Sponsors profile

### Requirement: Support through GitHub Sponsors still grants nothing

A contribution SHALL create no licence key, entitlement, local feature flag,
payment check in the desktop application, supporter-only functionality,
recurring obligation, private call, or priority-engineering promise. Public copy
SHALL state that supporting unlocks nothing, and no code path SHALL read
sponsorship state to decide what a user may do.

#### Scenario: The contribution surface makes the absence explicit

- **WHEN** the Support Endstate section of the supporters page is rendered
- **THEN** it states that supporting is not a licence, unlocks no features,
  carries no recurring obligation, and is not checked by the product

#### Scenario: No entitlement surface exists to grant

- **WHEN** the application is searched for a supporter entitlement, licence key,
  or sponsorship check
- **THEN** none exists, in the site, the API, or the desktop client

### Requirement: Supporter recognition is an opt-in acknowledgement, not advertising

The supporters page SHALL continue to render names parsed from the
`## Supporters` heading of `SUPPORTERS.md` in the Endstate engine repository,
names only, with no tier, amount, or transaction detail. The opt-in ask SHALL
arrive with the GitHub Sponsors thank-you, and the supporters page SHALL say both
that listing is opt-in and that a listing is an acknowledgement rather than
advertising or a benefit the contribution buys.

#### Scenario: The list is parsed from the engine repository

- **WHEN** the supporters page is rendered
- **THEN** it fetches `SUPPORTERS.md` from the Endstate engine repository and
  lists the entries under its `## Supporters` heading
- **AND** it shows no tier, amount, or transaction detail beside a name

#### Scenario: Consent and its nature are both stated

- **WHEN** the supporters page is rendered
- **THEN** it states that the GitHub Sponsors thank-you asks whether the
  contributor would like to be listed and that nothing is published without a yes
- **AND** it states that a listing is an acknowledgement, not advertising and not
  something a contribution buys

### Requirement: Commissioned work is routed to direct contact, not a sponsorship amount

Funding beyond the published amounts SHALL be a conversation rather than a
larger sponsorship. The Custom Project Sponsor option SHALL remain a
`mailto:founder@substratesystems.io` link carrying a prefilled subject, and
integration commissions SHALL remain on `/endstate/sponsor-an-integration`,
priced by quotation. Neither SHALL introduce a form, API route, or stored record.

#### Scenario: The custom option opens a mail draft

- **WHEN** the Custom Project Sponsor option is rendered
- **THEN** its link target is a `mailto:founder@substratesystems.io` address with
  a prefilled subject naming custom sponsorship

#### Scenario: Integration sponsorship is unchanged

- **WHEN** the supporters page points at integration sponsorship
- **THEN** it links to `/endstate/sponsor-an-integration`, which quotes by email

### Requirement: The Paddle supporter purchase path is retired without losing its history

Voluntary support SHALL have no Paddle checkout, webhook destination, thank-you
email template, or durable mail outbox drain, and its tier definitions SHALL
read no Paddle price identifier or environment variable. The
`supporter_contributions` and `supporter_email_outbox` tables, their migrations,
their existing rows, the operator-only legacy Patron import, and the `supporter`
and `supporter_purchased` analytics identifiers SHALL be preserved. Endstate
Cloud billing through Paddle SHALL be unaffected.

#### Scenario: No supporter checkout or webhook remains

- **WHEN** the application is searched for the voluntary-support payment path
- **THEN** no support checkout, no `/api/license/webhook` route, and no supporter
  thank-you template exists
- **AND** the support tier definitions contain no Paddle reference

#### Scenario: The follow-up cron no longer drains supporter mail

- **WHEN** the authenticated claim follow-up cron runs
- **THEN** it processes claim resends, founder alerts, and Paddle cancellation
  tombstones
- **AND** it neither reads the supporter mail outbox nor reports supporter mail
  counts

#### Scenario: Historical contributions survive the retirement

- **GIVEN** contributions recorded under the retired Paddle path
- **WHEN** the retirement ships
- **THEN** their rows and migrations are untouched and the operator-only legacy
  Patron import still exists
- **AND** the analytics identifiers they were recorded under are still reserved
