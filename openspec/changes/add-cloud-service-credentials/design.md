## Context

The Cloud gateway (`src/exomem-gateway/cloud-handler.ts`) admits one credential kind: an OAuth access token for the Cloud resource. It looks the token up by digest (`findCloudOAuthAccessToken`), maps it to the tenant's one cell, derives the per-cell bearer and signs an origin proof that carries tenant, cell, client, grant, family and resource. The cell trusts only that proof and the derived bearer.

A product backend, the first being a creator platform that keeps each creator's evidence in an Exomem cell, already calls a cell over MCP with one static bearer and reads the cell's discovery document before each connection. The Exomem side of this contract is `add-service-cell-contract` in the Exomem repository; its D6 has the gateway authenticate a product's service credential and sign the product principal into the proof.

## Goals / Non-Goals

**Goals**

- A product reaches exactly one tenant's cell with one long-lived secret, through the existing MCP pass-through.
- Rotation without downtime, and revocation that takes effect on the next request.
- The product reads its cell's discovery document through the gateway.

**Non-Goals**

- Separate authority for the product inside the cell. That is Exomem's service-principal stage. Until it ships, the product holds the owner's cell authority.
- The Exomem typed service API path. It gets its own forwarding change when Exomem ships it.
- Self-service issuance by tenants, or any OAuth change.

## Decisions

### D1. A separate credential table, not long-lived OAuth rows

Service credentials live in their own table: id, tenant, principal, secret digest, created and revoked times. An OAuth access token lives 15 minutes and sits under a grant, a token family and a client registration, and every OAuth check assumes that. A long-lived row in those tables would weaken that invariant for every reader of them. A separate table keeps each credential kind's lifetime rules in one place.

### D2. The secret's prefix selects the lookup

A service secret is `exs_` followed by 32 random bytes in base64url. The gateway sends a bearer with that prefix only to the service lookup, and any other bearer only to the OAuth lookup. A request therefore costs one lookup, and one kind can never be accepted as the other. The table stores the SHA-256 digest that the OAuth tables already use.

### D3. The lookup returns the shape the pass-through already uses

The service lookup applies the OAuth lookup's tenant and cell predicates: the tenant is not pending deletion or deleted, its owner has no account block, and its cell is not deleted. It returns the fields that the pass-through reads:

- `tenantId`, `cellId`, `cellDesiredState` and `userId` (the tenant owner);
- the credential id as both `grantId` and `familyId`;
- the principal as `clientId`;
- the configured Cloud resource;
- both required scopes.

The proxy, the desired-state gate, the derived bearer and the origin proof then run unchanged. The proof's client is the principal, such as `service:creator-platform`. Exomem's service-principal stage can map that client to a non-owner audience without a gateway change. The cell client-name and client-context headers come from the credential row, never from the request.

### D4. Limits

The identity rate limit and the per-identity concurrency guard apply with the key `tenantId:principal`. A resolved service credential skips the IP bucket, as the first-party client does: a product's servers call from a few shared addresses, and the identity limit still bounds them. A bearer with the service prefix that does not resolve still takes the IP bucket before its 401.

### D5. Rotation is two live credentials

The issue route refuses a third live credential for one tenant and principal with `SERVICE_CREDENTIAL_LIMIT`. A product rotates in three steps: issue a second credential, switch to it, then revoke the first. The issue transaction locks the tenant row so that two concurrent issues cannot both pass the count.

### D6. Discovery forwarding

`GET /.well-known/exomem-cell` on the gateway authenticates the caller with either credential kind and the same scope check. It applies the identity rate limit and the desired-state gate, then fetches the same path from the caller's cell. The cell serves discovery without a credential, and only the gateway and cellctl can reach a cell, so the gateway sends no bearer and no proof on this fetch. The gateway returns a 200 body unchanged, with `private, no-store`. It caps the body at 64 KiB, answers an unreachable cell with 503 `CELL_NOT_READY`, and answers any other upstream status with 502. It never forwards the caller's headers.

### D7. Operator routes

`/api/exomem/admin/service-credentials` takes the existing admin bearer:

- `POST` with `tenantId` (or the owner's email) and `principal` returns the id, principal, tenant, cell, Cloud MCP URL and the secret. The secret appears only in this response and in no log.
- `GET` lists a tenant's credentials without secrets.
- `DELETE` with an id revokes it. A repeat revoke succeeds without change.

The principal must match `^service:[a-z][a-z0-9-]{0,39}$`. That is a format check on an identifier, not a list of products.

## Risks / Trade-offs

- **The product holds owner authority on the cell until Exomem's service-principal stage.** Mitigation: the operator issues a credential only for a cell whose owner allows that product full access. The runbook states this, and the proof already names the principal so the later separation needs no reissue.
- **A leaked secret works until someone revokes it.** Mitigation: digest-only storage, the secret shown once, revocation on the next request, and two-key rotation that makes regular rotation cheap.
- **Discovery is now reachable through the gateway.** It holds no tenant content: protocol version, cell id, software identity, operations, limits and the recall-space id. Only an authenticated caller reaches its own cell's document.
