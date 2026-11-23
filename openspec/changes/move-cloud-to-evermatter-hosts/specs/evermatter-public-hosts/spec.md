## ADDED Requirements

### Requirement: Existing connections survive the host move

A token issued before the new host exists SHALL keep working at the host it was issued for,
and its refresh SHALL keep succeeding. No client SHALL have to reconnect because of the move.

#### Scenario: An existing client keeps calling the old host

- **WHEN** a client connected before the move calls the old MCP URL with its access token
- **THEN** the call succeeds as before

#### Scenario: An existing client refreshes

- **WHEN** that client refreshes with its stored `resource` value
- **THEN** the token endpoint issues a new token bound to the same resource

### Requirement: A token works only for an accepted resource

The gateway SHALL accept a token only when the token's stored resource is in the configured
set of accepted resources.

#### Scenario: A token for an unlisted resource

- **WHEN** a token whose stored resource is not in the configured set is presented
- **THEN** the gateway refuses it with a challenge

#### Scenario: A token at either host

- **WHEN** a token issued for the old resource is presented at the new host
- **THEN** the gateway accepts it, because both hosts front the same resource server

### Requirement: New connections get the new host

Discovery SHALL offer the first resource in the configured set to a client that has no stored
resource. Each host's protected-resource metadata SHALL name that host's own resource.

#### Scenario: A new client connects

- **WHEN** a new client starts the connection flow from the product's setup page
- **THEN** it receives the `mcp.evermatter.ai` URL and a token bound to that resource

### Requirement: Old public product paths redirect to evermatter.ai

A request for a public product page on `substratesystems.io` SHALL get a permanent redirect to
the same page on `evermatter.ai`. OAuth endpoints and product app pages SHALL NOT redirect.

#### Scenario: A visitor follows an old link

- **WHEN** a browser requests the old product landing page
- **THEN** it gets a 308 to `https://evermatter.ai/`

#### Scenario: The consent flow stays put

- **WHEN** a client's authorize request reaches the issuer
- **THEN** the consent page is served on the issuer's origin with no redirect
