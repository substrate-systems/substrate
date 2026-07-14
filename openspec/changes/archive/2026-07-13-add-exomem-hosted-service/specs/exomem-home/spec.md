## ADDED Requirements

### Requirement: Exomem Home reflects service state honestly

The signed-in Home surface SHALL render one of preparing, ready, degraded, suspended, export-in-progress, deletion-pending, or deleted states from authoritative control-plane data. It MUST NOT display a ready capture surface before the mapped cell passes private readiness.

#### Scenario: Tenant is provisioning

- **WHEN** the owner's cell is not yet ready
- **THEN** Home shows plain-language deterministic progress, polls a content-free status route, and exposes a request reference for support

#### Scenario: Tenant is ready

- **WHEN** the mapping, entitlement, protocol, and private readiness all permit service
- **THEN** Home presents capture and recall as the primary actions

#### Scenario: Tenant is suspended

- **WHEN** manual or entitlement suspension is active
- **THEN** Home prevents new writes, explains the available recovery/account actions, and never attempts to route around suspension

### Requirement: First use teaches capture through immediate recall

For a ready tenant with no completed onboarding marker, Home SHALL guide the user through one plain-language capture and one recall using Exomem's registry commands and product-safe defaults. It MUST NOT require Markdown, YAML, note types, vault paths, project keys, models, or MCP knowledge.

#### Scenario: User saves the first memory

- **WHEN** a ready first-time user submits non-empty memory text
- **THEN** Home invokes the governed capture command with server-selected defaults and displays a durable-save acknowledgement
- **AND** it offers a recall prompt derived without logging or analytics capture of the memory text

#### Scenario: User recalls the new memory

- **WHEN** the user submits a related recall query
- **THEN** Home displays the tenant's governed result and marks onboarding complete

### Requirement: Capture is simple but governed

The primary capture control SHALL accept ordinary text with an optional human title and SHALL preserve Exomem's content guards, mutation safety, idempotency, and stable validation errors. Repeated browser submission MUST NOT silently create duplicate canonical notes.

#### Scenario: Network acknowledgement is lost

- **WHEN** Home retries the same capture after an ambiguous network response
- **THEN** it reuses the same authenticated idempotency key and displays the one recorded result

#### Scenario: Capture violates a governed content rule

- **WHEN** Exomem rejects the capture with a stable validation or binary-blob error
- **THEN** Home presents a plain-language correction while preserving the request ID
- **AND** it does not bypass the rule or expose raw internal paths

### Requirement: Recall exposes useful results without infrastructure jargon

The primary recall control SHALL invoke the registry-backed recall command and display concise titles/excerpts or structured answer context belonging only to the current tenant. Empty, warming, degraded, and unavailable states MUST be distinct.

#### Scenario: Recall finds results

- **WHEN** the mapped cell returns governed recall hits
- **THEN** Home renders those hits without exposing tenant IDs, cell endpoints, protocol fields, or other users' data

#### Scenario: Lexical recall is ready while optional compute warms

- **WHEN** the cell reports optional semantic/media warming but permits lexical recall
- **THEN** Home keeps recall usable and labels the optional enhancement as warming rather than treating the service as down

#### Scenario: No result is found

- **WHEN** a successful tenant-scoped recall has no hits
- **THEN** Home explains that nothing matched and offers a narrower capture or revised query
- **AND** it does not imply that another tenant or global corpus was searched

### Requirement: Recent memory and review are secondary progressive disclosures

Ready Home SHALL offer recent memory, uploads, connections/review suggestions, and advanced account actions behind secondary controls while keeping capture and recall visually primary. These controls MUST route through the same authenticated gateway and entitlement checks.

#### Scenario: User opens recent memory

- **WHEN** a signed-in user expands the recent-memory panel
- **THEN** Home fetches only that tenant's registry-backed browse/recent result

#### Scenario: Optional capability is not granted

- **WHEN** a secondary action requires a capability absent from the entitlement
- **THEN** Home hides or disables it with an honest explanation and the server still enforces denial

### Requirement: Upload and download remain tenant scoped

Home SHALL obtain and use short-lived operation-specific transfer grants for file upload and download. It MUST NOT receive a cell master credential, private endpoint, tenant selector, or unrestricted vault access.

#### Scenario: User uploads a supported artifact

- **WHEN** the user chooses a file within the granted limits
- **THEN** Home obtains an upload grant and streams through the public tenant-bound transfer route
- **AND** successful preservation is shown using a human-facing label rather than an internal filesystem path

#### Scenario: Upload grant expires

- **WHEN** a grant expires before transfer completes
- **THEN** Home requests a new same-tenant grant or asks the user to retry
- **AND** it never reuses another session's grant

### Requirement: Portability and account controls are understandable and safe

Home SHALL provide service status, verified export request/status/download, billing source/status, sign-out, and product-scoped deletion. Destructive deletion MUST use a fresh single-use confirmation and distinguish queued work from completed destruction.

#### Scenario: Owner requests export

- **WHEN** an owner starts an export
- **THEN** Home shows asynchronous progress and presents a short-lived download only after integrity verification

#### Scenario: Owner starts deletion

- **WHEN** an owner initiates deletion
- **THEN** Home explains that Exomem data will be removed while unrelated products remain, sends a fresh confirmation, and does not delete on the first click

#### Scenario: Deletion is still destroying storage

- **WHEN** the cell is sealed but external destruction is pending
- **THEN** Home says deletion is in progress and offers no capture/recall surface

### Requirement: Authenticated Home content is private by default

Home, invite redemption, and account pages SHALL be `noindex`, SHALL NOT put vault content or queries into analytics, and SHALL prevent sensitive content from entering server logs, client error reporting, cache keys shared across users, or static rendering artifacts.

#### Scenario: Sensitive content causes a client or server error

- **WHEN** a capture, recall, path, file, or cell response contains a seeded sensitive sentinel
- **THEN** the sentinel is absent from analytics events, operational logs, shared caches, rendered error diagnostics, and request URLs

### Requirement: Home is accessible and resilient for non-technical users

The primary onboarding, capture, recall, status, export, and deletion flows SHALL support keyboard operation, programmatic labels, visible focus, meaningful loading states, reduced motion, and narrow mobile layouts. Recoverable errors MUST offer one concrete next action.

#### Scenario: User navigates with a keyboard on a narrow screen

- **WHEN** Home is used without a pointer at a mobile viewport
- **THEN** capture, recall, result, status, and account controls remain reachable in a logical order without horizontal scrolling

#### Scenario: Recoverable service error occurs

- **WHEN** an action fails with a retryable gateway or lifecycle code
- **THEN** Home preserves safe user input where appropriate, explains the next action, and displays a copyable request reference
