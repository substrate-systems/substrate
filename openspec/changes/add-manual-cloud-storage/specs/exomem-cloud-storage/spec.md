## ADDED Requirements

### Requirement: The owner confirms a provider-priced addition

The server SHALL authorize the current owner and active subscription before previewing or changing storage.
It SHALL derive unit capacity and selectable quantities from structured catalogue metadata and money from Paddle.
It SHALL preserve all existing items and quantities, use immediate proration and prevent a change after failed payment.

#### Scenario: A browser submits another subscription or an unsupported quantity

- **WHEN** the request contains an undeclared subscription field or a quantity outside the offered packs
- **THEN** no provider update occurs

### Requirement: An interrupted purchase remains recoverable

One durable unfinished operation SHALL bind the confirmed quote, complete target items, subscription and environment.
Concurrent or repeated confirmation SHALL NOT initiate another provider update.
An ambiguous result SHALL remain unknown until provider evidence resolves it.
Payment-method recovery SHALL use the owner's dedicated provider transaction and SHALL NOT grant storage from browser events.

#### Scenario: The response is lost after the provider applies the change

- **WHEN** the owner reloads or confirms again
- **THEN** the server recovers the existing operation from provider evidence without repeating the charge

### Requirement: Paid and observed capacity remain distinct

The application SHALL preserve paid storage through subscription events and request expansion only after payment proof.
The controller SHALL report actual bound-claim identity, resource version, status capacity and satisfied cell generation.
The UI SHALL report completion only for the operation's matching claim and sufficient observed capacity.
Existing grown capacity SHALL remain a floor. Automatic purchases, removal and shrinking SHALL remain unavailable.

#### Scenario: A pod becomes Ready before the disk grows

- **WHEN** observed claim capacity remains below the paid target
- **THEN** the purchase stays in the expanding state

#### Scenario: A different claim reports sufficient capacity

- **WHEN** its UID differs from the operation's original claim
- **THEN** that observation does not complete the purchase
