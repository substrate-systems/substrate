## Context

See proposal.md for motivation. The current OAuth store consults artifact-cohort state at client resolution, authorization, token exchange, access validation and refresh. `agent-contract-store.ts` also couples runtime promotion to artifact promotion, including rejecting an already-live candidate with a pending artifact. Removing one login predicate would leave both loops intact.

The canonical MCP implementation already exists in `src/lib/exomem-hosted/mcp.ts` and `gateway.ts`; the Next route is an adapter. The current request path performs several database stages, compiles validators per request and performs a private contract GET before a command POST. A missing-bearer request observed on 2026-09-07 returned in about 275 ms through an IAD function; that path does not touch the database and is not an authenticated latency baseline.

## Goals / Non-Goals

**Goals:** One service path, one policy authority, one command implementation; independent release and distribution decisions; an agent-operable launch workflow.

**Non-Goals:** Arbitrary DCR, new billing semantics, a second friends-only service, per-cell public OAuth, a replicated policy cache, new JWT credentials, a database migration to another provider, or relocating Home/browser transfers in this change.

## Decisions

### 1. Three independent decisions, using existing durable records

| Decision | Authority | Must not depend on |
| --- | --- | --- |
| Activate runtime | Signed candidate, immutable runtime tuple, fresh strict v2 fleet evidence and transactional compare-and-set | Certified client artifacts |
| Authorize service use | Approved client policy, identity/ownership, consent, audience/scopes, current account/grant/entitlement policy | Artifact promotion or transient cell readiness |
| Certify a client artifact | Exact artifact/client configuration plus genuine platform evidence against the active runtime | Making that runtime pending again |

Reuse the candidate's existing pending/live/retired state and unique active profile selection; do not add a parallel release state machine. Add a runtime-only activation transaction and separate artifact certification transaction. Both retain operator authorization, signed identity, audit receipts and stale-write protection. Existing paired promotion remains a composition for operators, not a service authorization requirement.

Activation atomically terminalizes preparing/active assignments and staged/evidenced stages for the activated candidate and any candidate it retires. Revoke every associated internal-canary credential, pending authorization transaction, code, grant, token family, refresh token and access token; preserve no canary exception merely because an artifact is live. Ordinary customer and independent provider-review grants are not internal-canary lineage and are not revoked by this cleanup. Remove the current `candidate.state = 'live'` escape from internal-canary admission. A transaction racing activation either commits first and is revoked by activation, or sees terminal state and fails.

Evidence is not authority. Preserve existing pending artifact records, their exact immutable runtime/client/stage provenance and `evidence_sha256`, plus the corresponding signed evidence payload in the durable acceptance output. Retiring a stage does not delete that artifact evidence. The independent certification operation validates that payload against the artifact digest and active runtime, without requiring the historical stage/assignment/credential to remain active. Fresh evidence gathered through ordinary approved service access after activation is also registrable without creating a new canary assignment. Permit operator-signed absent-or-identical platform lock attachment to a live candidate when its runtime tuple matches; attaching client metadata cannot rewrite runtime identity or activation. This closes both the internal-canary cleanup leak and the pending-artifact/live-runtime dead end.

Activation verifies a nonempty routable set against the exact candidate release, protocol, command fingerprint, agent schema digest and compatibility digest. Acquire the same exclusive admission fence used by lifecycle binding/activation, re-read the complete routable set and require an unchanged evidence digest inside the transaction. A pending candidate may be exercised only by the existing explicit operator canary mechanism. No empty-fleet promotion shortcut is introduced.

First-time provisioning still atomically snapshots the unique active runtime target together with invite consumption, capacity and lifecycle operation creation. Existing tenants reconnect without new capacity, volume or provision operations. Candidate activation and certification never silently mutate an in-flight lifecycle target.

### 2. Remove artifact admission everywhere, not just in the browser

Create one authoritative service-client eligibility predicate, independent of distribution artifacts. Apply it to metadata resolution/registered-client lookup, authorization start and completion, initial invite redemption, code exchange, access-token validation, refresh and contract selection. Keep client policy pins and CIMD allowlists/expiry/SSRF controls; removing certification does not make an unknown client eligible.

OAuth issuance and refresh enforce durable account and grant policy, not whether a pod happens to be ready. MCP discovery uses the approved immutable server contract without contacting a cell. Tool dispatch separately requires the current entitled, non-suspended, uniquely bound, compatible and ready cell. A deployment outage returns temporary service failure; it does not invalidate an otherwise-valid refresh family. Explicit account deletion, grant revocation, client-policy removal, suspension and entitlement denial still enforce their existing access policy centrally.

Remove only the artifact-related shared cohort fence from the hot path after concurrency tests prove it unnecessary. Retain token-family serialization, replay detection, policy reads and lifecycle/activation fences. No stale authorization allowance is introduced by this gateway move; the personal runtime's separate session-cache feature is not used for Substrate OAuth.

### 3. One handler, a nearby deployment

Add a Node HTTP entrypoint under `src/exomem-gateway/` that adapts streaming requests/responses to the existing handler. Keep Next as the rollback adapter over the same modules. Isolate environment/configuration imports so the gateway needs no Next request context or browser-session implementation. Preserve abort propagation, bounded bodies, MCP headers/status, SSE streaming, request IDs and graceful drain. The process is stateless across replicas; current shared SQL remains authoritative for tokens, grants, rate limits and routing.

Substrate owns one native Vercel external rewrite for the exact existing public MCP path, evaluated ahead of the legacy local route, targeting the companion infrastructure's dedicated tunnel origin. No Next MCP function is invoked on the new path. Explicitly disable external-rewrite caching with `x-vercel-enable-rewrite-caching: 0` and private/no-store responses, including errors and streaming responses. Test built routing precedence, header/status fidelity, timeout/cancellation and no cached replay across principals. OAuth endpoints and discovery documents stay in Substrate; issuer and resource audience remain explicit canonical configuration, never inferred from the internal origin Host. Transport movement alone does not require new grants. Use the documented native rewrite facility (https://vercel.com/docs/routing/rewrites), not a new Worker or whole-site DNS proxy change.

Public forwarded-IP headers are never trusted. The gateway trusts source metadata only when overwritten by its network-policy-restricted tunnel/ingress, and uses it as a pre-authentication network-source bucket. Behind Vercel this may be an aggregate proxy bucket, not the user's IP; account for that in its bound and retain authoritative per-identity SQL limits. The direct tunnel origin still enforces the same OAuth resource policy and cannot accept cell/admin paths. If a deployed ingress cannot establish source provenance, fail closed on the trusted-header path and use a bounded aggregate bucket; do not accept an arbitrary forwarded value.

The external proxy allows at most 120 seconds to the first response and between response chunks, not necessarily 120 seconds total for an active stream (https://vercel.com/changelog/cdn-origin-timeout-increased-to-two-minutes). Preserve the current bounded tool-dispatch deadline (10 seconds) and verify Authorization, MCP protocol/session headers, response streaming and cancellation through the real rewrite. Do not introduce an idle long-lived stream whose correctness depends on exceeding an intermediary's silence timeout; prove reconnect behavior if a supported host uses the stream endpoint.

For local cell calls, deployment configuration supplies one fixed private Traefik origin and the existing configured control hostname. A validated authoritative stored endpoint must match that hostname and the canonical mapped-cell path before its origin is translated. Never accept a caller-provided endpoint, arbitrary URL rewrite or cross-origin redirect. HTTP is allowed only for this fixed cluster-local origin under the existing trusted-cluster transport model and enforced NetworkPolicy; the remote adapter remains HTTPS-only. Unique cell credentials and cell/principal/protocol checks remain mandatory. The gateway gets no Kubernetes administration, provider provisioning or billing secrets.

### 4. Optimize immutable work, retain fresh policy

Cache parsed contracts/tool maps/AJV validators by the complete immutable identity (profile, release, protocol, fingerprint, schema and compatibility digests), with bounded entries and eviction. Do not cache credentials, tenant destinations, entitlement decisions or successful bearer validation across requests. Measure SQL stage counts and durations before combining queries; correctness does not depend on an unmeasured cache scheme.

The companion Exomem artifact defines an additive private agent command route with mandatory expected-contract headers. Use it only when the approved compatibility artifact advertises `agent-command-binding-v1`. The cell validates profile, source release, protocol, command fingerprint and published schema digest from its own runtime. Catalog/plugin compatibility digest stays a control-plane/candidate/fleet check: it depends on client packaging not present in the cell image, so the gateway must not pretend the cell can recompute it. On the new route the separate contract GET is removed; on older approved runtimes the current GET-and-command behavior remains. Contract mismatch never triggers a fallback to the legacy route. This avoids both a network hop and the old time-of-check/time-of-use gap.

### 5. Automated acceptance is part of the product work

Use a durable operator-owned synthetic tenant and explicitly approved client identity. Test the ordinary customer authorization and transport path; no production-only bypass and no direct database token seeding presented as OAuth proof. A scripted standards client covers token rotation/replay, restart, discovery, capture, semantic recall with citation, wrong audience, revocation, suspension and cross-tenant denial. Browser automation covers the actual login/consent flow when an authenticated test browser is available. Real host-client runs remain necessary before claiming that host is certified; generic protocol tests cannot manufacture platform evidence.

Runs are resumable, use run-scoped fixtures and stable idempotency keys, preserve test-tenant data and record pass/fail/blocked separately. One report contains immutable release IDs, commands, latency distributions and next required action. A missing external login/consent prompts once with the exact action, while independent tests continue; it never causes a series of operator-driven canary resets. Secrets and personal memory content stay out of artifacts.

## Risks / Trade-offs

- A shared gateway is an additional deployment to operate → one existing handler, pinned image, bounded resources, health/drain checks and native-rewrite rollback; no new policy service or Worker.
- Neon distance or serialized policy work may dominate after moving transport → measure real database region and per-stage timings before tuning. This plan promises no latency from topology alone.
- Old plans still call artifact certification service admission → reconcile the affected active deltas during implementation before canonical spec synchronization; never archive contradictory requirements over this change.
- Access-boundary changes can fail open under concurrency → explicit negative and race tests precede implementation; independent review exercises them against disposable state.

## Migration Plan

1. Land additive activation/certification operations, new service eligibility queries and tests. Retain old views for reporting/compatibility; do not drop data.
2. Activate the verified runtime, exercise ordinary approved-client authorization, reconnect and discovery on the current adapter. This is a useful independent admission release.
3. Deploy a cell release supporting the new private binding route, preserving legacy routes. Register and activate its signed runtime tuple through the same procedure.
4. Build/deploy the gateway using canonical code, current database authority and dedicated least-privilege secrets. Validate its private origin before any public traffic switch.
5. Switch only the public MCP path at the edge; run the acceptance gates in the companion Exomem change, including >15-minute token continuity and >1-hour fleet credential renewal. Freeze runtime changes during that evidence window.
6. Certify each actual client artifact after its genuine host run. Publish only certified artifacts; service use remains independent.

Rollback transport by restoring the previous edge origin without changing the public URL or token records. Retain both adapters and private route compatibility through acceptance. Roll back admission code before any destructive schema cleanup; restoring artifact gates is an explicitly disruptive emergency action, not an automatic response to cell downtime. Runtime rollback must follow existing signed-candidate and fleet compatibility rules.
