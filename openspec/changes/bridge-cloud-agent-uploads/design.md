# Design

## Context

See the proposal for motivation and Exomem's `capture-agent-files` contract for portable handoff fields.
The current gateway already authenticates exact-resource OAuth, streams to a fixed cell route and signs artifact grants.
Its transfer-tool module serves control-plane operations; it does not issue Source tickets.
The cell owns tickets, authorization context, held bytes and capture receipts. It cannot call Home to check an OAuth origin.

## Goals / Non-Goals

The bridge adds verified Cloud origin and routing to the existing receiver without another ticket store.
It preserves personal upload behavior and transparent JSON/SSE MCP responses.
Resumable uploads, arbitrary cell routes, a new listener and media-provider offload are outside this change.

## Decisions

### One ticket store and two signed gateway objects

Reuse the existing Ed25519 signing-key plumbing, with separate audiences for origin proof and upload routing.
Each object binds the exact resource, tenant, cell, client, grant and family, plus version, issuer, expiry and request identifier.
Map the origin to `session_id=grantId`, `generation=familyId`, `audience=resource`; token refresh preserves that family.
Display headers never supply these facts.

The gateway replaces private origin headers on forwarded MCP requests.
The cell verifies that proof alongside its authenticated cell bearer and constructs the complete Cloud principal.
Its existing ticket retains the vault, deployment, lane, hash, byte limit and authorization context.
The route capsule supplies routing authority only; a substituted ticket still fails the cell's complete binding check.
Gateway ticket issuance would duplicate the cell's command and authorization boundary, so it is rejected.

### Additive capability envelope

The Cloud token is `exomem-cloud-upload:v1:<capsule-hex>:<ticket-nonce>`.
The nonce remains the cell ticket's 64 lowercase hexadecimal characters.
The capsule encodes the complete compact JWT's ASCII bytes as canonical lowercase hex.
The verifier decodes those bytes and verifies that unchanged JWT; it never reconstructs JSON for signature checking.
This follows the existing upload-capability encoding and needs no credential-scrubber exception.
The CLI bounds and recognizes the envelope; recognition supplies no authority.
The gateway verifies its signature, audience, issuer, lifetime and canonical encoding.

The capsule lifetime does not exceed the existing 900-second handoff cap.
The descriptor uses the fixed HTTPS `/upload` gateway endpoint and fits the CLI's existing 16 KiB input bound.
The cell clamps its ticket expiry and limit to the verified capsule and portable contract.
The raw OAuth bearer and cell bearer never enter this envelope.

### Revalidate before streaming

Extract shared origin validation beside the existing access-token lookup.
Preserve its full admission, first-party, generic-client, reviewer, family, grant, tenant and exact-resource predicates.
The browser owner-principal helper loses login identity and cannot validate this delegation.

The gateway authenticates the capsule before pulling body bytes, then resolves its current origin and cell.
The upload requires a running write-admitting cell; control-plane transfer tools keep their separate availability rule.
The gateway signs fresh upload proof bound to the inner ticket's SHA-256.
It forwards the derived cell bearer and private ticket header to the cell's fixed upload handler.
Existing stream cancellation, concurrency accounting and response filtering remain in use.

The cell compares fresh proof with the stored ticket principal before consumption or body reads.
It reuses the existing bounded receiver, hash assertion and held-file writer.
A matching current proof validates Cloud origin; absence of that proof refuses Cloud delegation without changing personal authority validation.
Later capture arrives through ordinary authenticated MCP with fresh origin proof and the same complete binding.

### Controls and their costs

Origin, encoding, expiry and binding refusals prevent cross-login or cross-tenant upload authority.
A false refusal costs one upload attempt; the client retains its original bytes and existing receipts.
Streaming byte bounds prevent unbounded storage use; a wrong cap refuses the file and belongs in deployment configuration.
No human approval is added to an upload.

## Risks / Trade-offs

The added maintenance is one versioned cross-language envelope, key rotation and a streaming gateway route.
Hex doubles capsule length; an actual postfilter-to-CLI workflow proves the complete descriptor fits.
A revocation during streaming can leave uncommitted held bytes. Recheck origin before relaying success; later capture still requires current authority.
The cell has no callback, so this design promises no continuous revocation polling during a stream.
A lost reply can consume a ticket without delivering a handle. Report uncertainty; do not replay it automatically.

## Migration Plan

1. Deliver the compatible cell verifier and private receiver with issuance disabled; existing personal uploads still work.
2. Deliver the gateway route and origin proof with issuance disabled; ordinary Cloud MCP still works.
3. Enable only an isolated sandbox cell and run the exact-byte workflow; the original and captured bytes match.
4. Enable production only through a separate operator action; retain the reviewed undo and receipts.

Rollback disables new issuance and restores the prior package or gateway image as needed.
Existing capture receipts remain canonical, and uncommitted holds expire through their existing lifecycle.
