## ADDED Requirements

### Requirement: Browser reads remain bound to the owner

The viewer SHALL resolve the current session and use only its owner and tenant to mint a short-lived first-party token.
The browser SHALL NOT select a tool, cell, gateway or authorized tenant.
Map, search and read requests SHALL enforce the existing Origin and CSRF checks and strict input shapes.
Responses SHALL prevent caching and referrer disclosure. Tokens SHALL remain on the server.

#### Scenario: A browser supplies another tenant

- **WHEN** a request carries a tenant binding different from its session
- **THEN** the route refuses before minting a token or calling the cell
- **AND** the viewer clears cached content

#### Scenario: The account changes between reads

- **WHEN** another tab changes the signed-in account after the initial map
- **THEN** a later request cannot combine the earlier account's map with the new account's note

### Requirement: Viewer calls use three bounded read operations

The map route SHALL call only `viewer_map`. Search SHALL use ordinary `ask_memory` retrieval.
Note reads SHALL use `read_memory` and the existing disclosure rules.
Requests and responses SHALL have byte bounds and the existing five-second transport deadline.
The bridge SHALL NOT follow redirects or return arbitrary provider response fields.

#### Scenario: A browser supplies a tool name or extra arguments

- **WHEN** a request includes an undeclared field
- **THEN** the route refuses without calling the cell

#### Scenario: The cell lacks the map command

- **WHEN** the cell returns an unknown-method answer
- **THEN** the viewer reports unavailable state without a fabricated empty vault

### Requirement: Graph and retrieval values retain their source meaning

The viewer SHALL preserve complete, partial, empty and unavailable states.
Exact totals SHALL remain null when the source cannot prove them. Drawn counts SHALL describe returned items.
Node references and relation identities SHALL retain the source's values.
Search SHALL use assistant retrieval over titles and text, and note reads SHALL follow admitted references.

#### Scenario: A large map is capped

- **WHEN** eligible notes exceed the drawing limit
- **THEN** the viewer distinguishes the drawn notes from the source's exact or unknown total

#### Scenario: Two relation instances share a spelling

- **WHEN** two admitted definitions use the same relation name
- **THEN** the viewer preserves their distinct identities and descriptions

#### Scenario: Search returns semantic units or a continuation

- **WHEN** assistant retrieval returns its MCP list or envelope with semantic-unit matches
- **THEN** the viewer uses each source-provided parent reference and title to open the note
- **AND** it offers the next opaque continuation without discarding existing results

#### Scenario: Search is still warming

- **WHEN** the source marks the search as warming, degraded or incomplete
- **THEN** the viewer shows that results are incomplete instead of claiming that no notes match

### Requirement: The supplied viewer remains accessible and read-only

The viewer SHALL follow the supplied desktop and phone layouts in both themes.
The note reader SHALL replace the map on phones and desktops. Reduced motion SHALL keep content readable without travel.
The reader SHALL render note text without executing HTML, scripts or unsolicited remote assets.
The phone panel SHALL use the shared peeking and expanded sheet. Graph gestures SHALL support touch pinch as well as mouse controls.
An unreachable view SHALL retain same-account content with its observation time and the drawn retry treatment.
Authorization loss SHALL clear that content instead of retaining it as an unreachable snapshot.

#### Scenario: A note contains executable markup

- **WHEN** an admitted note includes a script or unsafe URL
- **THEN** the reader displays safe content without executing the markup or following that URL
