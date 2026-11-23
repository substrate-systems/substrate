## ADDED Requirements

### Requirement: The operator declares every service notice

The system SHALL record a service notice only when the operator creates one through the authenticated admin route. A notice SHALL be `maintenance` or `incident`, carry an operator summary of at most 280 characters, and cover either the whole fleet or a named set of existing cells. No alert, health proof or release step SHALL create a notice.

#### Scenario: Operator schedules fleet-wide maintenance

- **WHEN** the operator creates maintenance with a future start, a later end, a summary and no cells
- **THEN** the notice covers every cell

#### Scenario: Request without the operator token

- **WHEN** a request without a valid operator token calls the admin route
- **THEN** the system refuses it and records nothing

### Requirement: Notice times decide its state

Maintenance MUST start in the future and end after it starts. It SHALL be scheduled from its announce time, 48 hours before the start unless the operator sets another, until the start, and active until the end. An incident MUST start no later than now and SHALL stay active until the operator resolves it.

#### Scenario: Maintenance in the past

- **WHEN** the operator creates maintenance whose start has passed or whose end is not after its start
- **THEN** the system refuses it and records nothing

#### Scenario: Maintenance starts

- **WHEN** the start time of scheduled maintenance passes
- **THEN** the maintenance is active until its end

### Requirement: Cancelled and resolved notices are final

The operator MAY cancel maintenance that has not ended and resolve an active incident. A cancelled or resolved notice MUST NOT change again.

#### Scenario: A cancelled notice cannot be reopened

- **WHEN** the operator tries to cancel or resolve a notice that is already cancelled or resolved
- **THEN** the system refuses the change and the notice keeps its times

### Requirement: Covered owners get one maintenance email before it starts

When maintenance is scheduled, the system SHALL queue one `maintenance_scheduled` email to the owner of each covered tenant whose cell is not deleted. The email SHALL state the start and end in the owner's time zone, the operator summary and the status page address. Each owner MUST receive it at most once per notice. The system MUST NOT send it after the maintenance is cancelled or has started.

#### Scenario: Maintenance covers two cells

- **WHEN** the operator schedules maintenance that names two cells
- **THEN** the owners of those two tenants each receive one maintenance email
- **AND** no other owner receives one

#### Scenario: Maintenance is cancelled before its email is sent

- **WHEN** the operator cancels maintenance while its emails wait in the outbox
- **THEN** the waiting emails are not sent

### Requirement: Notice email fan-out is bounded and idempotent

Fan-out SHALL run in bounded batches in the delivery job, outside the operator request. Each batch MUST use a constant number of queries, whatever its size. A repeated batch MUST NOT queue a second email for the same owner and notice.

#### Scenario: Fan-out repeats

- **WHEN** the delivery job processes the same notice again after a crash
- **THEN** no owner receives a second email for that notice

### Requirement: Covered owners hear when an incident is over

When the operator resolves an incident, the system SHALL queue one `incident_resolved` email to the owner of each covered tenant whose cell is not deleted, at most once per incident. The email SHALL state when the incident started and ended in the owner's time zone and the operator summary. The system MUST NOT send it for an incident that is still active.

#### Scenario: Incident on one cell is resolved

- **WHEN** the operator resolves an incident that covered one cell
- **THEN** that tenant's owner receives one incident-resolved email
- **AND** no other owner receives one

### Requirement: The gateway tells a covered cell about a current notice

For each MCP request it forwards to a cell, the gateway SHALL set the `x-exomem-service-notice` header when a current notice covers that cell, and SHALL NOT set it otherwise. A notice is current while maintenance is scheduled or active, or while an incident is active. When several notices are current, the gateway SHALL send an active incident first, then active maintenance, then the earliest scheduled maintenance.

#### Scenario: Scheduled maintenance covers the cell

- **WHEN** a person's assistant calls a tool on a cell that scheduled maintenance covers
- **THEN** the forwarded request carries the notice header with state `scheduled` and the maintenance times

#### Scenario: Incident covers another cell

- **WHEN** an active incident names other cells only
- **THEN** a request to this cell carries no notice header

### Requirement: The notice header has one bounded shape

The header value SHALL be base64url-encoded UTF-8 JSON of at most 1,024 bytes. It SHALL carry `v` (1), `kind`, `state` (`scheduled` or `active`), `starts_at`, `ends_at` (null for an active incident) and `say`, text of at most 400 characters that begins "Tell the user once in this conversation: " and then gives the notice for the assistant to relay. The header MUST NOT carry tenant data.

#### Scenario: Long operator summary

- **WHEN** the composed `say` text would exceed 400 characters
- **THEN** the gateway shortens it to fit and the header stays within 1,024 bytes

### Requirement: Callers cannot forge the notice header

The gateway MUST NOT forward a caller's own `x-exomem-` header, including `x-exomem-service-notice`.

#### Scenario: Caller forges the header

- **WHEN** a caller sends its own `x-exomem-service-notice` header
- **THEN** the gateway refuses the request as it refuses any caller `x-exomem-` header

### Requirement: Notice changes reach the gateway quickly

A new, cancelled, ended or resolved notice SHALL reach every gateway instance within 30 seconds. The gateway MUST NOT query the database for notices on every request.

#### Scenario: Notice ends

- **WHEN** maintenance ends or the operator resolves an incident
- **THEN** forwarded requests stop carrying that notice within 30 seconds

### Requirement: One operator command mirrors the notice to the status page

The operator script SHALL create, cancel or resolve a notice through the admin route and mirror it to the public status repository with the operator's own GitHub login. Before it creates a notice, it SHALL show the covered tenant count and the composed `say` text and wait for the operator's confirmation.

#### Scenario: Operator schedules maintenance with the script

- **WHEN** the operator schedules maintenance with the script and confirms
- **THEN** the notice exists in substrate
- **AND** the status page lists it under scheduled maintenance with its start and end

### Requirement: Status issues follow Upptime and name no one

Maintenance SHALL appear as an open issue labelled `maintenance` with its start and end in Upptime's metadata block, closed on cancellation. An incident SHALL appear as an issue labelled `status`, closed on resolution. A status issue MUST NOT name a tenant or a cell.

#### Scenario: Operator resolves an incident with the script

- **WHEN** the operator resolves an incident with the script
- **THEN** its status issue is closed with a one-line account of what happened
- **AND** the issue names no tenant or cell
