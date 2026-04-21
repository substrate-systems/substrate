## ADDED Requirements

### Requirement: Endpoint path and method
The system SHALL expose a public installer download endpoint at `/api/download` accepting HTTP GET.

#### Scenario: GET request resolves to an installer
- **WHEN** an HTTP GET request is made to `/api/download`
- **THEN** the system responds with either a 302 redirect to a GitHub Release asset URL, or a 503 when the upstream release cannot be resolved

### Requirement: Format query parameter
The system SHALL accept an optional `format` query parameter with values `exe` or `msi`. If omitted, invalid, or any other value, the system MUST treat the request as `format=exe`.

#### Scenario: Default format is exe
- **WHEN** a GET request is made to `/api/download` with no `format` parameter
- **THEN** the resolved asset filename ends with `.exe`

#### Scenario: Explicit msi format
- **WHEN** a GET request is made to `/api/download?format=msi`
- **THEN** the resolved asset filename ends with `.msi`

#### Scenario: Invalid format falls back to exe
- **WHEN** a GET request is made to `/api/download?format=dmg`
- **THEN** the resolved asset filename ends with `.exe`

### Requirement: Asset resolution
The system SHALL fetch the latest release metadata from the `endstate-gui` repository via the GitHub REST API and select the first asset whose filename ends with `.<format>` and does not end with `.sig`.

#### Scenario: Signature files are excluded
- **WHEN** the upstream release contains assets whose names end with `.exe.sig`
- **THEN** the system does not select any `.sig` asset as the redirect target

### Requirement: 302 redirect on success
On successful asset resolution, the system MUST respond with HTTP 302 and a `Location` header equal to the asset's `browser_download_url`.

#### Scenario: Redirect target is the GitHub CDN URL
- **WHEN** an asset matching the requested format is found
- **THEN** the response status is 302 and the `Location` header starts with `https://github.com/Artexis10/endstate-gui/releases/download/`

### Requirement: Upstream caching
The system SHALL cache the GitHub release metadata fetch for 300 seconds using Next.js fetch revalidation.

#### Scenario: Repeated requests within 5 minutes share upstream response
- **WHEN** multiple requests to `/api/download` arrive within 300 seconds of the first
- **THEN** the system does not issue a new fetch to `api.github.com` for each request

### Requirement: Failure handling
On upstream fetch error, upstream non-2xx response, or absence of a matching asset, the system SHALL respond with HTTP 503 and JSON body `{ "error": "download_unavailable" }`.

#### Scenario: Upstream returns non-2xx
- **WHEN** the fetch to `api.github.com` returns a status outside 200-299
- **THEN** the endpoint responds with HTTP 503 and body `{ "error": "download_unavailable" }`

#### Scenario: Upstream fetch throws
- **WHEN** the fetch to `api.github.com` throws a network error
- **THEN** the endpoint responds with HTTP 503 and body `{ "error": "download_unavailable" }`

#### Scenario: No matching asset
- **WHEN** the latest release metadata contains no asset matching the requested format
- **THEN** the endpoint responds with HTTP 503 and body `{ "error": "download_unavailable" }`

### Requirement: Failure logging
On any failure path, the system SHALL emit a `console.error` entry containing the upstream URL and enough context (status code, error message, or missing-asset indication) to diagnose the failure from Vercel logs.

#### Scenario: Failure logs include context
- **WHEN** the endpoint returns 503 for any reason
- **THEN** a `console.error` entry is emitted that includes the upstream GitHub API URL and a machine-readable reason

### Requirement: No authentication
The system MUST NOT require authentication, authorization header, or session cookie on requests to `/api/download`.

#### Scenario: Anonymous request resolves
- **WHEN** an HTTP GET request without any authentication header is made to `/api/download`
- **THEN** the system responds with either 302 or 503 — never 401 or 403
