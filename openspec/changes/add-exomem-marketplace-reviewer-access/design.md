## Context

Hosted Exomem authenticates ordinary users through invitation and magic-link flows, then reuses normal browser sessions during OAuth. Marketplace reviewers need a stable username/password pair that the provider can exercise without access to a private inbox, MFA, SMS, or a private network. The credential must not become a second customer auth system or bypass tenant admission.

The reviewer account is a dedicated, already-provisioned Hosted owner and an immutable reviewer-purpose tenant with a live entitlement, cell, and versioned generic fixture. The purpose is selected on a dedicated operator-issued invitation and propagated at first tenant creation; it cannot be retrofitted onto an existing ordinary customer tenant. Substrate owns the identity/session boundary; Exomem owns the fixture definition and content-bearing review cases. Broad public signup remains a separate product decision.

## Goals / Non-Goals

**Goals:**

- Give each provider a high-entropy, reusable, expiring reviewer credential bound to one dedicated existing reviewer-purpose owner/tenant.
- Store only a lookup digest and Argon2id password hash, return plaintext once, and make rotation/revocation immediately invalidate reviewer sessions and OAuth access.
- Authenticate only inside an active Hosted OAuth continuation whose trusted client platform matches the credential provider, bind that continuation to the credential, and then use the existing confirmation and token flows.
- Fail closed with durable pre-KDF rate limits, generic public failures, no credential logging, and a default-disabled public surface.
- Record a fixture version so operator review access and Exomem's review cases refer to the same seeded data contract.

**Non-Goals:**

- Ordinary username/password login, customer signup, public auto-invites, or capacity reservation.
- Provisioning a user, tenant, entitlement, cell, volume, or fixture from the public reviewer endpoint.
- Storing provider credentials, raw sample content, or reviewer tenant identifiers in Git or public evidence.
- Replacing invitation/magic-link access or changing MCP/OAuth client admission.

## Decisions

### Use provider-scoped generated credentials bound to existing state

An additive table will hold one active credential per provider (`openai` or `anthropic`) with a SHA-256 username digest, Argon2id password hash, owner/tenant binding, fixture version/digest, expiry, operator-principal digest, and revocation metadata. `exomem_tenants` and operator invitations gain an immutable `account_purpose`; only a dedicated reviewer-purpose invitation can create a reviewer-purpose tenant, and credential creation requires that marker. The operator route generates a random opaque username and password, validates that the target is an existing usable reviewer-purpose owner/tenant, atomically revokes the prior provider credential, and returns plaintext exactly once.

Accepting operator-chosen passwords was rejected because generated entropy is simpler to validate and safer to share through provider review systems. A general local-password table was rejected because ordinary Hosted access remains invitation/magic-link based.

### Limit authentication to an active OAuth continuation

The reviewer form appears only on the Hosted authorization screen when `EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED=true`. The JSON authentication route requires the existing same-origin check and a valid unconsumed OAuth continuation. In one transaction it verifies that the continuation client's trusted `client_platform` matches the credential provider, binds the continuation to the credential, and inserts an ordinary `exomem_sessions` row for the pre-bound principal. The reviewer still uses the existing explicit authorization confirmation, which requires the session and continuation credential bindings to match.

A standalone reviewer login was rejected because provider review only needs the OAuth journey and a narrower entry point reduces credential reuse outside that context.

### Make verification enumeration-resistant and cost-bounded

Before Argon2 work, the route applies durable IP and keyed-username rate limits. Missing, disabled, unknown, wrong, expired, revoked, unusable-tenant, and rate-limited credentials return the same no-store authentication failure. Unknown usernames are checked against a fixed dummy Argon2id hash so the main timing shape remains comparable. Logs and audit events contain only request IDs, stable event names, provider class after successful lookup, and digests where needed—never submitted usernames or passwords.

In-memory throttling was rejected because it does not survive serverless concurrency or restarts. Returning a distinct 429 was rejected because it exposes a useful account/credential oracle on this tiny credential population.

### Tag reviewer sessions and revoke the derived access graph

`exomem_sessions`, OAuth authorization transactions, and OAuth grants gain nullable reviewer-credential references. The authorization transaction is bound during reviewer login and the binding propagates to the grant. Ordinary flows keep all three references null. Rotation or revocation marks the credential revoked and transactionally revokes sessions, authorization transactions/codes, grants, token families, refresh tokens, and access tokens derived from that binding without creating an account block or deleting the tenant.

Session resolution, authorization completion, code exchange, refresh, and MCP access-token lookup require an attributed credential to remain active and unexpired. Session and token-family expiries are capped at the credential expiry as defense in depth. Thus credential expiry makes derived access unusable even if an operator has not yet run explicit revocation.

Using the existing full account-block operation was rejected because credential rotation is reversible operational hygiene, not a permanent account denial. Relying on credential expiry alone was rejected because already-issued sessions and OAuth tokens would survive.

### Treat fixture readiness as an operator assertion plus native proof

The credential stores the expected generic fixture version and payload digest. Credential creation validates the immutable reviewer-purpose marker and owner/tenant runtime state but does not inspect knowledge content. The runbook requires seeding the canonical checked-in generic payload through the normal Hosted MCP path and completing Exomem's named review cases in clean provider clients.

Directly writing sample notes from the control-plane database was rejected because Substrate must not bypass Exomem's governed write path.

## Risks / Trade-offs

- [Argon2 login can be abused for compute] -> Apply durable IP and keyed-username limits before verification, use bounded parameters, and keep the feature default-off.
- [Rotation leaves an active OAuth token] -> Revoke the credential, its tagged sessions, and the bound dedicated account's OAuth grants/families atomically; test the full graph.
- [Operator binds a real customer tenant] -> Require the immutable reviewer-purpose marker created through a dedicated reviewer invitation; ordinary customer tenants cannot be relabelled.
- [Credentials leak through logs or responses] -> Return them only from the authenticated creation/rotation response, redact all public errors, and extend sensitive-text tests.
- [Provider review takes longer than expiry] -> Allow an operator-selected bounded expiry and rotate through the same endpoint; attributed sessions and OAuth access stop at credential expiry.
- [Feature-flag/cached-page drift] -> Mark authorization and access routes dynamic/no-store and test default-disabled rendering and behavior.

## Migration Plan

1. Apply additive migration `0035` with an empty reviewer-credential table and nullable session reference.
2. Deploy with reviewer login disabled; ordinary access and OAuth behavior remain unchanged.
3. Issue and redeem a dedicated reviewer-purpose operator invitation, then seed that tenant through the normal MCP flow.
4. Create provider credentials through the authenticated operator route, store plaintext in the provider/operator secret handoff, and enable the feature flag.
5. Complete clean-client review cases and rotate or revoke credentials after provider review.

Rollback disables the feature flag first, then revokes active reviewer credentials and derived sessions/OAuth access. The additive table/column can remain; no tenant or fixture data is deleted by rollback.

## Open Questions

None. Broad admission, pricing, and public capacity are deliberately deferred to a separate product-launch decision.
