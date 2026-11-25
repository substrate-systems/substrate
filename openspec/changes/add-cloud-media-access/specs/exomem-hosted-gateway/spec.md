## ADDED Requirements

### Requirement: A signed-in owner downloads a stored original through a short-lived ticket

A signed-in owner session SHALL obtain a download ticket only for the serving cell that the session resolves to, never one named by the request. The ticket SHALL bind the tenant, cell, owner login and exact path with the purpose `download`, live at most 10 minutes, and serve any number of Range requests for that path inside its life. The app SHALL answer 302 to the gateway and SHALL NOT carry the media bytes.

#### Scenario: The owner plays and seeks an evicted recording

- **WHEN** a signed-in owner opens the download route for a stored original
- **THEN** the app answers 302 to the gateway's download address with a ticket
- **AND** the gateway answers each Range request with 206 and the cell's Content-Range

#### Scenario: A session cannot reach another tenant's cell or path

- **WHEN** a request carries another `cell_id` or `tenant_id`, or a ticket is presented for a different path
- **THEN** the app resolves the cell from the session alone
- **AND** the gateway refuses the ticket before it contacts a cell

#### Scenario: No session, a cross-site request or a reviewer session

- **WHEN** the request has no session, is cross-site, or belongs to a reviewer session
- **THEN** the app answers 401 for no session and 403 for the others, and mints no ticket

### Requirement: The gateway accepts a download ticket on GET /download only and keeps its per-request checks

The gateway SHALL accept a ticket on `GET /download` as an alternative to the OAuth bearer and SHALL refuse a request that carries both. It SHALL verify the ticket before any database work, then apply the rate limit, concurrency slot, login revocation and block checks, tenant deletion check and cell state check of the OAuth route. It SHALL refuse the ticket on `/mcp`, `/upload` and every other path, and SHALL NOT log it.

#### Scenario: An invalid or expired ticket

- **WHEN** a ticket is expired, minted for another path, altered, or signed with another key
- **THEN** the gateway answers 401 without a database read or a cell request

#### Scenario: The login ends inside the ticket's life

- **WHEN** the owner's login is revoked, the tenant is deleting, or the owner is blocked
- **THEN** the gateway refuses the ticket on the next request

#### Scenario: The ticket is presented to another route

- **WHEN** a download ticket is sent to `/mcp` or `/upload`
- **THEN** the gateway does not read it as a credential
