## ADDED Requirements

### Requirement: The Cloud gateway serves the transfer tools from the control plane

When `EXOMEM_CLOUD_TRANSFER_TOOLS_ENABLED` is `true`, the Cloud gateway SHALL answer a single JSON-RPC `tools/call` for `observe_transfer` or `transfer_memory` itself. It SHALL do so after authentication, scope, rate-limit and concurrency checks and before the cell desired-state gate. It SHALL call the Substrate web API at the configured public base URL with the caller's own bearer and nothing else from the request, refuse redirects, and bound the time and the size of the answer. A batch, a notification, another method, another tool, and a request whose `mcp-name` header names another tool SHALL pass to the cell unchanged. With the flag off, every request SHALL pass to the cell unchanged. The gateway MUST NOT gain database access for these tools.

#### Scenario: Owner checks a transfer while the cell is held

- **WHEN** an owner whose cell is stopped calls `observe_transfer` with action `status`
- **THEN** the gateway answers from the web API without contacting the cell
- **AND** the web API receives only the caller's bearer

#### Scenario: The web API refuses the bearer

- **WHEN** the web API refuses a request with an error body
- **THEN** the gateway returns an application result with the web API's error code, message and remediation, and HTTP 200
- **AND** a body without a remediation gets `reconnect` for a 401, `retry` for a retryable refusal, and `see_message` otherwise
- **AND** it does not return an HTTP challenge to the MCP client

#### Scenario: The control plane does not answer

- **WHEN** the web API answers 5xx, times out or cannot be reached
- **THEN** the result carries the code `CONTROL_PLANE_UNAVAILABLE` and the remediation `retry`
- **AND** the import half and the export half of a status fail independently
- **AND** `import_handoff` still returns its routes, with the failure in its `open_import` half

#### Scenario: The call is not a single transfer tool call

- **WHEN** the request is a batch, a notification, a call to another tool, or carries an `mcp-name` header that differs from the tool name
- **THEN** the gateway forwards the request body to the cell unchanged

#### Scenario: The flag is off

- **WHEN** the flag is unset or not `true`
- **THEN** the gateway forwards every request, including calls to the two tools, to the cell as before

### Requirement: Transfer tool results carry no capability and no bytes

A result of `observe_transfer` or `transfer_memory` SHALL NOT contain an upload URL, a recipient, an export download link, `urls_expire_at`, a `ciphertext_*` field or file bytes. An expected failure SHALL be an application result `{success: false, error: {code, message, remediation}}` with `isError` false. The actions `import_discard` and `export_request` SHALL make no write call until the caller passes `confirm: true`, and the result without it SHALL name the effect and carry the code `UNCONFIRMED`. The tools SHALL validate every identifier as a UUID before the gateway builds a URL.

#### Scenario: The web API reply carries capability fields

- **WHEN** the import or export reply from the web API includes upload URLs, a recipient or ciphertext fields
- **THEN** the tool result includes none of them

#### Scenario: Caller discards without confirming

- **WHEN** a caller asks for `import_discard` or `export_request` without `confirm: true`
- **THEN** the gateway returns `UNCONFIRMED` with the import, or with the export's effects and a fresh export id
- **AND** it makes no write call to the web API

#### Scenario: Caller passes a malformed identifier

- **WHEN** an `import_id` or `export_id` is not a UUID, or an argument is unknown
- **THEN** the result carries `INVALID_ARGUMENTS` and the gateway makes no web call

### Requirement: Transfer tool contract is generated from the Exomem registry

The gateway SHALL take the names of the two transfer tools, their actions, their input property names, their required lists and their defaults from a module that the instruction-block sync script generates from Exomem's Cloud-only tool schema fixture. Its argument schemas SHALL type-check against the generated property names and required lists, and its handlers SHALL switch exhaustively over the generated actions. A property or action that Exomem adds, renames or drops therefore fails the type check. A scheduled job SHALL fail when the fixture on Exomem's main branch differs from the generated module.

#### Scenario: Exomem adds an action

- **WHEN** Exomem's fixture lists an action that the gateway does not handle
- **THEN** the weekly drift job fails
- **AND** after the module is regenerated, the type check fails until the gateway handles the action

#### Scenario: Exomem renames or adds an input property

- **WHEN** Exomem's fixture renames `import_id` or adds a property to a transfer tool
- **THEN** the weekly drift job fails and names the tool and the part that differs
- **AND** after the module is regenerated, the type check fails until the argument schema takes the same properties
