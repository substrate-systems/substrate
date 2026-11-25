## ADDED Requirements

### Requirement: A signed-in owner downloads a stored original through a ticket

A signed-in owner session SHALL obtain a download ticket only for the serving cell that the session resolves to, never one named by the request. The ticket SHALL bind the tenant, cell, owner grant and login family, and exact path with the purpose `download`. It SHALL live for the configured ticket life, 4 hours by default and at most 24 hours, and serve any number of Range requests for that path inside its life. The app SHALL answer 302 to the gateway and SHALL NOT carry the media bytes.

#### Scenario: The owner follows a link to a stored original

- **WHEN** a signed-in owner opens the download route for a stored original
- **THEN** the app answers 302 to the gateway's download address with a ticket
- **AND** the gateway answers each Range request with 206 and the cell's Content-Range

#### Scenario: A session cannot reach another tenant's cell or path

- **WHEN** a request carries another `cell_id` or `tenant_id`, or a ticket is presented for a different path
- **THEN** the app resolves the cell from the session alone
- **AND** the gateway refuses the ticket before it contacts a cell

#### Scenario: No session or a reviewer session

- **WHEN** the request has no session or belongs to a reviewer session
- **THEN** the app answers 401 for no session and 403 for a reviewer session, and mints no ticket

### Requirement: The app admits a link from another site only as a navigation

The app SHALL admit a cross-site request to the download route only when its fetch metadata names a navigation to a document. It SHALL refuse every other cross-site request, and SHALL write no grant for a refused request.

#### Scenario: The owner follows a link from a web client

- **WHEN** the owner follows a link on another site, and the request is a cross-site navigation to a document
- **THEN** the app answers 302 with a ticket

#### Scenario: Another site loads the route in the background

- **WHEN** a cross-site request is a fetch, an image, a script or a frame
- **THEN** the app answers 403 and mints no ticket

### Requirement: The ticket lives on the owner's grant, not on the browser session

A ticket SHALL stay valid for its life after the owner signs out or the owner's browser sessions are revoked. Only the end of the owner's grant, a blocked owner, a deleting tenant or a deleted cell SHALL end it earlier. The app SHALL sign a ticket only against a login family that outlives the ticket.

#### Scenario: The owner signs out while a recording plays

- **WHEN** the owner signs out, and a Range request then reaches the gateway with the issued ticket
- **THEN** the gateway answers 206

#### Scenario: The owner revokes the grant

- **WHEN** the owner's grant is revoked
- **THEN** the gateway refuses the ticket on the next request

### Requirement: The gateway accepts a download ticket on GET /download only and keeps its per-request checks

The gateway SHALL accept a ticket on `GET /download` as an alternative to the OAuth bearer and SHALL refuse a request that carries both. It SHALL verify the ticket before any login lookup or cell request, then apply the rate limit, concurrency slot, login revocation and block checks, tenant deletion check and cell state check of the OAuth route. It SHALL refuse the ticket on `/mcp`, `/upload` and every other path, and SHALL NOT log it.

#### Scenario: An invalid or expired ticket

- **WHEN** a ticket is expired, minted for another path, altered, or signed with another key
- **THEN** the gateway answers 401 without a login lookup or a cell request

#### Scenario: The grant ends inside the ticket's life

- **WHEN** the owner's grant is revoked, the tenant is deleting, or the owner is blocked
- **THEN** the gateway refuses the ticket on the next request

#### Scenario: The ticket is presented to another route

- **WHEN** a download ticket is sent to `/mcp` or `/upload`
- **THEN** the gateway does not read it as a credential

### Requirement: Media downloads have their own concurrency pool

The gateway SHALL give media downloads a per-process pool of their own, set by `EXOMEM_GATEWAY_MAX_MEDIA_DOWNLOADS` with a default of 16. It SHALL keep the per-tenant slot cap, and SHALL answer 429 with a Retry-After header when the pool is full. A full media pool SHALL NOT refuse an MCP call.

#### Scenario: The media pool is full

- **WHEN** every media slot is held by a stream and another download arrives
- **THEN** the gateway answers 429 with Retry-After
- **AND** an MCP call from the same process is still served

### Requirement: A ticket response is hardened for the browser

The gateway SHALL send `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and `content-security-policy: sandbox` on every response to a ticket request. It SHALL force `content-disposition: attachment` unless the cell's content type is audio or video.

#### Scenario: A stored page is downloaded

- **WHEN** the cell serves an HTML original to a ticket request
- **THEN** the gateway answers with `content-disposition: attachment` and the sandbox policy
