## ADDED Requirements

### Requirement: The gateway names the authenticated client to a Cloud cell

On every request that it forwards to a Cloud cell, the gateway SHALL set two headers from the access token's stored client. `x-exomem-oauth-client` SHALL carry the client's display name, the same name the app list shows. `x-exomem-client-context` SHALL carry `coding` when every redirect URI that the client registered is a loopback URI, and `conversation` otherwise. Both values MUST come from the control plane's client registry and never from the request. The gateway MUST refuse or replace a caller's copy of either header, so that no caller-supplied value reaches the cell.

#### Scenario: Chat app calls its cell

- **WHEN** a client whose registered redirect URIs include a web URI calls the Cloud MCP address
- **THEN** the cell receives `x-exomem-client-context: conversation` and the client's display name in `x-exomem-oauth-client`

#### Scenario: Local agent calls its cell

- **WHEN** a client whose registered redirect URIs are all loopback URIs calls the Cloud MCP address
- **THEN** the cell receives `x-exomem-client-context: coding`

#### Scenario: Caller sends its own client header

- **WHEN** a request to the Cloud MCP address carries `x-exomem-oauth-client` or `x-exomem-client-context`
- **THEN** the gateway refuses the request, or replaces the value, and the caller's value never reaches the cell

#### Scenario: Stored name cannot travel in a header

- **WHEN** the client's stored name contains characters that an HTTP header value cannot carry
- **THEN** the gateway sends the next display name that the app list would use: the platform name, else the redirect host

### Requirement: The gateway records when each app last reached its Exomem

When the gateway forwards a request from a connected app to its Cloud cell, it SHALL record the time against that app's grant. The time SHALL move at most once in five minutes. The gateway MUST NOT record a request from the first-party Home client. Recording MUST NOT delay or refuse the request; a failed record SHALL be logged with the database error code only. The record SHALL live outside the OAuth tables, so the gateway keeps no write on them.

#### Scenario: App calls its cell

- **WHEN** a connected app's request passes authentication, scope and rate checks
- **THEN** the gateway forwards it and records the time against the app's grant

#### Scenario: Record fails

- **WHEN** the gateway cannot record the time
- **THEN** the request is still forwarded and answered as usual
- **AND** the log line names the database error code and no request content

#### Scenario: Home calls its cell

- **WHEN** the first-party Home client calls the Cloud MCP address
- **THEN** the gateway records nothing for it
