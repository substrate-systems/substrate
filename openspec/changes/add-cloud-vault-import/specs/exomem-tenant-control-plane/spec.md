## ADDED Requirements

### Requirement: Encrypted import requests separate tenant intent from controller observations

C5 SHALL store content-free import requests under a C1 cell with the types and split grants in the design. It MUST permit one open import per cell, including pending cleanup and any discard request not yet observed as discarded. Substrate SHALL write request/report columns only; cellctl SHALL write transport/observation columns only. The gateway SHALL have no C5 access. C1 SHALL support an `import` hold.

#### Scenario: Runtime roles cross the ownership boundary

- **WHEN** Substrate writes controller columns, cellctl writes request columns, or the gateway accesses C5
- **THEN** PostgreSQL rejects the operation, including after default grants or migration reruns

#### Scenario: Two requests race for one cell

- **WHEN** concurrent requests create imports for one cell
- **THEN** at most one open row exists
- **AND** cancellation leaves the row open until cellctl reports a terminal observation

#### Scenario: Cell deletion precedes cleanup

- **WHEN** a cell still has import records
- **THEN** PostgreSQL restricts deletion of the cell until lifecycle cleanup removes those records

### Requirement: Cleanup retries release bounded holds without claiming success

The controller SHALL report `cleanup_pending` for unfinished cleanup and preserve the original import error code. Each attempt SHALL use a bounded hold and confirm that its Job controllers and Pods are absent before release. The controller SHALL back off between attempts using `updated_at`. Lifecycle deletion SHALL take precedence, and hold release MUST preserve stopped desired state. Pending cleanup SHALL occupy the cell's open import slot.

#### Scenario: Cleanup fails after an import outcome

- **WHEN** cleanup fails or reaches its deadline
- **THEN** status reports `cleanup_pending` with the original import error code
- **AND** the controller removes its Jobs and Pods and confirms their absence before releasing the hold
- **AND** cleanup retries after backoff without claiming successful completion

#### Scenario: An older discard competes with a new import

- **WHEN** a tenant discards an older import while another import is open
- **THEN** the request returns 409 without changing the older request
- **AND** an accepted older discard blocks new imports until the controller reports `discarded`

### Requirement: Import endpoints derive authority from existing Cloud credentials

Import endpoints SHALL accept a verified Cloud bearer with both read/write scopes or an existing browser session. An Authorization header MUST exclude cookie fallback. Every read/write SHALL bind the verified tenant to its C1 cell. Browser mutations SHALL retain CSRF checks. Starts and completions SHALL require writable lifecycle; status and cancellation SHALL remain available during suspension.

#### Scenario: A caller selects another tenant's import

- **WHEN** a caller submits another tenant's import identifier
- **THEN** reads and mutations return 404 and reveal no upload URLs or recipient

#### Scenario: Invalid bearer accompanies valid cookies

- **WHEN** Authorization is malformed, revoked, expired, wrong-resource, or lacks either scope
- **THEN** the endpoint refuses bearer authority without using cookies
- **AND** a 401 response points to the existing Cloud resource metadata

#### Scenario: Suspended tenant manages pending work

- **WHEN** a suspended tenant polls or cancels an import
- **THEN** the endpoint records or reports that tenant's request
- **AND** new imports and completion reports remain refused

### Requirement: Accepted upload reports are immutable and replay safe

Public creation SHALL support additive `adopt` and `archive_members` requests, with an optional UUID for idempotency. Preparation SHALL freeze the ciphertext digest and size before cellctl allocates exact parts and reports their sizes. Completion SHALL atomically accept the issued part ETags, ciphertext SHA-256, and ciphertext size. An exact accepted retry SHALL succeed; conflicting reports MUST fail. Cancellation and discard SHALL record intent without fabricating controller success. Status SHALL distinguish pending from observed states.

#### Scenario: Encrypted size determines upload parts

- **WHEN** a client reports its ciphertext digest and size after recipient-bound encryption
- **THEN** C5 freezes that tuple while requested_state remains requested and notifies cellctl
- **AND** cellctl can publish exactly sized parts before completion

#### Scenario: Concurrent completions disagree

- **WHEN** two completion requests report different authenticated ciphertext tuples
- **THEN** one tuple is accepted and the other returns a conflict
- **AND** later retries cannot replace the accepted tuple

#### Scenario: Public caller requests vault replacement

- **WHEN** a tenant submits `restore` through the public creation endpoint
- **THEN** the request is refused and no import is created

### Requirement: Ordinary CLI clients use Cloud OAuth admission

The control plane SHALL seed the pinned `exomem-cloud-cli` client with the canonical loopback callback and the existing redirect digest. It SHALL retain NULL marketplace identity and permit ephemeral loopback ports through the existing redirect rule. Rerunning migrations MUST preserve operator disablement.

#### Scenario: Operator disables the CLI client

- **WHEN** the operator disables the client and migrations run again
- **THEN** the client remains disabled and Cloud OAuth admission refuses it
