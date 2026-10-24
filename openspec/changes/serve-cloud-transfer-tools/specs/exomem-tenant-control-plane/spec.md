## ADDED Requirements

### Requirement: Owner exports accept the owner's Cloud OAuth bearer

The owner export routes (status, request and link) SHALL accept either the owner's browser session or the owner's Cloud OAuth access token. One resolver SHALL decide the caller for imports and exports. A bearer MUST be an access token for the Cloud resource that carries both Cloud scopes, and it takes no CSRF proof. A request that carries an `Authorization` header SHALL NOT fall back to its cookies. A session SHALL present its CSRF proof on every mutation. A caller SHALL reach only its own tenant's exports. The display of a ready export SHALL include its archive digest, so that a client can verify a download. The link SHALL be returned only in the HTTP response to the authenticated owner and never logged.

#### Scenario: Owner's command line downloads its own export

- **WHEN** the owner's Cloud CLI presents the owner's access token and reads, requests and asks for the link of an export
- **THEN** the routes answer as they do for Home
- **AND** the display of a ready export includes `archive_sha256`

#### Scenario: Another tenant's token

- **WHEN** a valid token of another tenant asks for an export or its link
- **THEN** the status shows no export and the link request answers 404 without recording a request

#### Scenario: Wrong resource or one scope

- **WHEN** a token is for another resource, or carries only one of the two Cloud scopes
- **THEN** the routes answer 401 for the resource and 403 for the scope
- **AND** a 401 carries the Cloud resource's `www-authenticate` challenge

#### Scenario: Browser session without its CSRF proof

- **WHEN** a session requests an export or its link without the CSRF proof
- **THEN** the route answers 403

#### Scenario: Bearer fails while cookies are valid

- **WHEN** a request carries an invalid bearer and valid session cookies
- **THEN** the route answers 401 and does not use the cookies
