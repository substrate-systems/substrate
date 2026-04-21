# updater-manifest Specification

## Purpose
TBD - created by archiving change add-updater-manifest-endpoint. Update Purpose after archive.
## Requirements
### Requirement: Manifest endpoint path and method
The system SHALL expose the Tauri updater manifest at the URL path `/updates/latest.json` via an HTTP GET request.

#### Scenario: GET request returns latest manifest
- **WHEN** an HTTP GET request is made to `/updates/latest.json`
- **THEN** the system responds with the Tauri updater manifest body for the latest `gui-v*` release of the `endstate-gui` repository

### Requirement: Response content type
The system SHALL return the manifest with `Content-Type: application/json`.

#### Scenario: Successful response is JSON
- **WHEN** the endpoint responds successfully (HTTP 200)
- **THEN** the `Content-Type` response header starts with `application/json`

### Requirement: Edge caching headers
The system SHALL set the response header `Cache-Control: public, s-maxage=300, stale-while-revalidate=60` on successful responses.

#### Scenario: Cache-Control header on successful response
- **WHEN** the endpoint responds with HTTP 200
- **THEN** the `Cache-Control` response header equals `public, s-maxage=300, stale-while-revalidate=60`

### Requirement: Manifest body is proxied unchanged
The system MUST NOT add, remove, rename, or modify any field of the upstream `latest.json` asset. The response body MUST be the JSON parsed from the upstream asset, serialized without added fields.

#### Scenario: Body matches upstream
- **WHEN** the upstream `latest.json` asset is fetched successfully
- **THEN** the endpoint's response body contains exactly the same top-level keys and nested structure as the upstream JSON, with no additions or removals

### Requirement: Upstream failure handling
On any non-2xx response from the upstream GitHub release asset, or on a fetch error, the system SHALL return HTTP 503 with a JSON body `{ "error": "manifest_unavailable" }`.

#### Scenario: Upstream returns non-2xx
- **WHEN** the fetch to the upstream `latest.json` asset returns a status outside the 200-299 range
- **THEN** the endpoint responds with HTTP 503 and JSON body `{ "error": "manifest_unavailable" }`

#### Scenario: Upstream fetch throws
- **WHEN** the fetch to the upstream `latest.json` asset throws a network error
- **THEN** the endpoint responds with HTTP 503 and JSON body `{ "error": "manifest_unavailable" }`

### Requirement: Upstream failure logging
On upstream failure, the system SHALL emit a `console.error` log entry containing the upstream URL and the status code (or error message, for thrown errors).

#### Scenario: Non-2xx is logged
- **WHEN** the upstream fetch returns a non-2xx status
- **THEN** a `console.error` entry is emitted that includes the upstream URL and the numeric status code

### Requirement: No authentication required
The system MUST NOT require any authentication, authorization header, cookie, or bearer token on requests to `/updates/latest.json`.

#### Scenario: Anonymous request succeeds
- **WHEN** an HTTP GET request without any authentication header is made to `/updates/latest.json`
- **THEN** the system responds with the manifest (HTTP 200) or an upstream-failure 503, never a 401 or 403

