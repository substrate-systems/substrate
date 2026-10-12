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
