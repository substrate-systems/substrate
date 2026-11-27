## ADDED Requirements

### Requirement: Home shows the owner's monthly update email setting

Home SHALL show the owner's "Monthly update email" setting and SHALL let the owner turn it on or off. Home SHALL show the value that the email's unsubscribe link last set. A reviewer account SHALL NOT see the setting.

#### Scenario: Turned off from the email

- **WHEN** an owner unsubscribes through a digest's link and then opens Home
- **THEN** Home shows the setting off

### Requirement: Home invites an existing owner once

The setting SHALL start off for an owner who signed up before the digest shipped, and on for an owner whose signup offered the opt-out. Home SHALL invite an owner whose setting started off to turn it on, until that owner accepts or dismisses the invitation.

#### Scenario: An existing owner dismisses the invitation

- **WHEN** an owner who signed up before the digest shipped dismisses the invitation and reopens Home
- **THEN** Home shows no invitation, and the setting stays off
