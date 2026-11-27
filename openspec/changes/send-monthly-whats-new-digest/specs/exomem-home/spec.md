## ADDED Requirements

### Requirement: Home shows the owner's monthly update email setting

Home SHALL show the owner's "Monthly update email" setting and SHALL let the owner turn it on or off. Home SHALL show the value that the email's unsubscribe link last set. A reviewer account SHALL NOT see the setting.

#### Scenario: Turned off from the email

- **WHEN** an owner unsubscribes through a digest's link and then opens Home
- **THEN** Home shows the setting off

### Requirement: Home invites an existing owner once

The setting SHALL start off for an owner who signed up before the digest shipped. Home SHALL invite such an owner to turn it on while their setting is off, they have not dismissed the invitation and they have never turned the setting on. Home SHALL NOT show the invitation to an owner who signed up after the digest shipped.

#### Scenario: An existing owner dismisses the invitation

- **WHEN** an owner who signed up before the digest shipped dismisses the invitation and reopens Home
- **THEN** Home shows no invitation, and the setting stays off

#### Scenario: The setting is already on

- **WHEN** the operator turned the setting on for an owner who signed up before the digest shipped
- **THEN** Home shows the setting on and no invitation

#### Scenario: An owner turned it on and later unsubscribed

- **WHEN** an owner who signed up before the digest shipped turned the setting on, then unsubscribed through a digest's link, and opens Home
- **THEN** Home shows the setting off and no invitation
