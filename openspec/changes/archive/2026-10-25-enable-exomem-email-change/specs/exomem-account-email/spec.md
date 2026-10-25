## ADDED Requirements

### Requirement: Account email changes preserve Exomem identity

An authenticated owner SHALL be able to change the Exomem account email without changing notes, tenant identifiers, active sessions or connected apps.
The change MUST NOT alter another product's sign-in identity. Reviewer accounts MUST NOT change their assigned address.

#### Scenario: Owner confirms a new address

- **WHEN** an owner requests a change and confirms the new address before expiry
- **THEN** future Exomem sign-in links use the new address
- **AND** existing sessions, grants, notes and identifiers remain valid
- **AND** the previous address cannot authenticate the previous Exomem account

#### Scenario: Another product uses the previous address

- **WHEN** the owner changes the Exomem email
- **THEN** that product retains its existing sign-in address and credentials

#### Scenario: Owner deletes Exomem

- **WHEN** the verified deletion workflow finishes scrubbing the account
- **THEN** its Exomem identity retains only its identifier and dates as a deleted tombstone
- **AND** its email and verification time are cleared while the shared-product identity remains unchanged

### Requirement: Email confirmation and cancellation are single use

The system SHALL send a fifteen-minute confirmation to the proposed address and a cancellation action to the original address.
It MUST store token digests, serialize confirmation with cancellation and reject expired or superseded requests without changing identity.
Link navigation MUST NOT mutate account state. A proposed address MUST NOT reserve or merge another account.

#### Scenario: Cancellation wins the race

- **WHEN** cancellation commits before confirmation
- **THEN** confirmation cannot change the account address

#### Scenario: Confirmation wins the race

- **WHEN** confirmation commits before cancellation
- **THEN** cancellation cannot restore the original address
- **AND** repeated confirmation creates no second change

#### Scenario: The new address is already used

- **WHEN** another Exomem identity owns the proposed address at confirmation
- **THEN** the change fails with a generic conflict
- **AND** neither identity is merged or reassigned

### Requirement: Receipt synchronization reports its actual state

The system SHALL synchronize the confirmed address to the existing Paddle customer, including shared future receipts.
It MUST retain customer identity, verify provider readback and distinguish synchronized, pending, conflict and failed states.
Provider failures MUST NOT reverse the Exomem address change. Permanent conflicts MUST NOT retry indefinitely or merge provider customers.

#### Scenario: Provider response is lost

- **WHEN** a contact update has an uncertain outcome
- **THEN** reconciliation reads the existing customer and retries only the latest desired address
- **AND** Home reports pending until the provider state is known

#### Scenario: Another provider customer owns the address

- **WHEN** Paddle refuses the update because the address belongs to another customer
- **THEN** Home shows the receipt conflict and known receipt address
- **AND** the confirmed Exomem address and current customer binding remain unchanged
- **AND** the owner can choose another address or use billing and support actions
