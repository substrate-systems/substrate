## 1. Pin Protocol, Security, And Data Contracts

- [x] 1.1 Add failing pure tests for protected-resource and authorization-server metadata, `WWW-Authenticate`, supported MCP negotiation, bearer-header-only authority, resource/audience binding, PKCE S256, exact redirect validation, and content-free OAuth errors.
- [x] 1.2 Add failing pure tests for approved pre-registration/CIMD resolution, public-HTTPS and SSRF boundaries, exact allowlisted host/client/redirect matching, and fetch/cache/size/redirect limits; dynamic registration remains off for alpha.
- [x] 1.3 Add failing pure tests for authorization-code single use, opaque access/refresh digests, client/resource/scope/family binding, atomic refresh rotation, replay-family revocation, and current entitlement/lifecycle enforcement.
- [x] 1.4 Add safe additive migrations `migrations/0025_exomem_mcp_oauth.sql` for authorization transactions/codes, grants/token families, approved or bounded client metadata, and live/pending agent contracts, plus `migrations/0026_exomem_capacity.sql` for multidimensional capacity reservations/occupancy/claims. Backfill uncertain existing tenant/provider state as occupied, never free, and make no provider calls in migrations.
- [x] 1.5 Pin the official TypeScript MCP transport dependency and any narrowly required OAuth primitives, documenting why their protocol/security behavior is used instead of a handwritten transport parser.

## 2. Implement Exomem OAuth Discovery And Tokens

- [x] 2.1 Implement bounded client identity resolution and cache/storage for operator-pinned clients, validated CIMD, and default-off per-host DCR compatibility.
- [x] 2.2 Implement protected-resource and authorization-server metadata routes plus standards-correct unauthenticated/invalid-token challenges at the canonical Exomem MCP resource.
- [x] 2.3 Implement sealed authorization transactions and the authorize route with client/redirect/resource/scope/state/PKCE binding and safe resumption through existing browser, invite, and magic-link identity.
- [x] 2.4 Implement single-use code exchange, opaque short-lived access tokens, rotating refresh families, revocation, audience/scope checks, and raw-secret redaction.
- [x] 2.5 Add route/integration tests for login resume, upstream identity-provider independence after grant creation, code interception/replay, refresh races/replay, per-client revocation, account-wide denial, and restart continuity.

## 3. Add Atomic First-Login Capacity Admission

- [x] 3.1 Add failing database/integration tests for atomic invite validation plus capacity reservation, one identity/tenant/entitlement/grant/initial-provision operation, rollback on exhausted capacity, reusable invite on failure, and zero provider calls before commit.
- [x] 3.2 Add concurrent tests for duplicate OAuth callbacks and first-login races proving exactly one reservation, tenant, entitlement, provision operation, cell, and volume.
- [x] 3.3 Implement the admission transaction by extending the existing access/database boundary, while making existing entitled owners attach without another reservation or infrastructure operation.
- [x] 3.4 Implement capacity-ledger transitions for reserved, occupied, uncertain, released, and retained-storage states plus globally bounded provisioning claims.
- [x] 3.5 Extend lifecycle reconciliation and provisioner fakes for conservative lost-ack handling, release only after verified absence/destruction, suspension runtime release, and resume-time runtime reacquisition of the same cell.

## 4. Import And Promote The Exact Agent Contract

- [x] 4.1 Extend `scripts/generate-exomem-hosted-contract.mjs` and fixtures to import the Exomem `hosted-alpha-agent-v1` contract, canonical tool schemas/descriptions/annotations, profile fingerprint, full schema digest, protocol range, and source release without a copied allowlist.
- [x] 4.2 Add failing tests for deterministic import, pending/live atomic promotion, stale or incompatible candidate rejection, unchanged live discovery during rollout, and exact agreement with both Exomem package locks.
- [x] 4.3 Implement contract storage/promotion and an operator-visible check that all routable cell releases expose the exact profile-specific private contract before a candidate becomes live.
- [x] 4.4 Add failing generator/gateway tests, generate the exact full-gateway fixture for the current live 0.34.0 agent candidate from Exomem commit `253c9aa365d7afd8829dc7843f1cac53353ac825`, generate the 0.35.0 candidate fixture from `d4c5614e5f65d8bcbddee90e9e374846c5a2c22f`, and implement an immutable versioned catalog only after both coherent units exist; prove real 0.34-live/0.35-candidate tenants select different exact fixtures and reject the 0.24-full/0.34-agent split, missing, ambiguous, mutable, historical-only, or cross-release entries.
- [x] 4.5 Add failing unit and real-PostgreSQL tests for operator-only preparing/active rollout assignments on reviewer and ordinary existing tenants, immutable generations and compare-and-swap expiry, exact tenant-aware pending/live contract resolution, public selector rejection, unassigned-tenant isolation, reviewer-only OAuth/evidence authority, ordinary-tenant fail-closed maintenance plus fresh post-promotion authorization, and mismatched-cell behavior.
- [x] 4.6 Add failing staged-client tests that exact candidate/package/archive/compatibility/schema/version/OAuth/registered-app declarations permit reviewer canary client registration before evidence, carry no acceptance claim, cannot promote, reject drift, require later signed artifacts to match byte-for-byte, and atomically transition to evidenced authority or revoke all dependent lineage on pre-evidence expiry/removal/failure/retirement.
- [x] 4.7 Add failing credential/OAuth tests that issuing a short-lived operator-held internal-canary credential seals the invite-created setup graph and enables a fresh attributed reviewer authorization before evidence while provider-review credentials remain unissued, and that candidate ID, assignment generation, declaration ID, and matching client identity remain bound through completion, grant/code exchange, access lookup, token-family creation, refresh rotation, evidence transition, promotion continuity, and atomic descendant revocation; cover old live-client access/discovery/call/refresh rejection.
- [x] 4.8 Add failing lifecycle tests that unassigned provision/restore snapshots live, reviewer and ordinary fleet rollout snapshot their preparing assignments including the exact gateway digest and agent locks, retries cannot drift after promotion or environment change, health omission/mismatch blocks activation, and quiesce/export/restore/rebind activates only after exact replacement-cell readiness.
- [x] 4.9 Add failing rollback tests that re-import the retained prior release as a new pending candidate, create fresh assignment generations, reject historical evidence and retired-row revival, stage mixed rollback/live tenants safely, revoke mismatched live-client lineage on activation, and require the ordinary fresh-evidence promotion compare-and-swap.
- [x] 4.10 Add the side-effect-free additive `migrations/0036_exomem_agent_contract_canaries.sql`, then implement the candidate gateway catalog binding, durable fleet assignments, immutable staged client releases, lifecycle target snapshots, candidate/client-bound OAuth lineage and revocation, tenant-aware MCP selection, content-free operator controls/status, staged cell rollout, promotion cleanup, and forward-path rollback under the Hosted cohort lock.

## 5. Implement The Protected Streamable HTTP MCP Resource

- [x] 5.1 Add failing transport tests for initialize, tools/list, tools/call, supported protocol versions, stateless or safely scoped MCP sessions, request cancellation/deadlines, and malformed or oversized messages.
- [x] 5.2 Implement `src/app/api/exomem/mcp/route.ts` and the shared MCP adapter so authenticated initialize/tools/list are served from the live contract without a tenant cell call or wake.
- [x] 5.3 Add failing gateway tests for exact token-to-identity-to-tenant-to-cell resolution, reserved-field rejection, entitlement/read-write scope checks, profile-only private forwarding, no bearer passthrough, and no full-route or cross-tenant fallback.
- [x] 5.4 Implement canonical tools/call forwarding through the existing gateway and the cell's profile-specific private agent route, preserving canonical envelopes and scoped idempotency.
- [x] 5.5 Add stable `TENANT_PREPARING`, capacity, provisioning-failed, suspended, deleted, not-ready, and incompatible-contract MCP result mappings with bounded retry timing and opaque support references.

## 6. Bound Cost, Abuse, And Telemetry

- [x] 6.1 Add failing tests that plugin install, OAuth metadata/challenges, client metadata/registration, failed authentication, ineligible authorization, initialize, and tools/list create no tenant infrastructure or cell wake.
- [x] 6.2 Enforce the 5 GiB usable storage, 90 MiB upload ceiling, and zero-worker alpha projection at admission/readiness while keeping excluded expensive commands absent from MCP.
- [x] 6.3 Extend pre-auth IP and post-auth identity/client rate limiting with bounded request/response bytes, concurrent calls, retries, timeouts, and provision claims; add adversarial amplification tests.
- [x] 6.4 Extend content-free observability and cost metrics for opaque client/cohort, reservations, storage occupancy, active runtime, provider operations, MCP calls/bytes/retries, latency, and stable errors.
- [x] 6.5 Add sentinel leak tests spanning OAuth, MCP, gateway, capacity, lifecycle, provisioner, promotion evidence, responses, and logs.

## 7. Wire Private Distribution And Operations

- [x] 7.1 Add invite/Home install actions for promoted Claude and OpenAI artifacts only, with no manual connector URL or tenant-specific package and no exposure to ineligible users.
- [x] 7.2 Add operator controls for client admission, token-family/account revocation, contract promotion/demotion, capacity totals, provision concurrency, and safe cohort rollout.
- [x] 7.3 Update `docs/runbooks/exomem-hosted-alpha.md` with OAuth keys/rotation, metadata routes, capacity accounting, preparing/failure diagnostics, suspension/resume behavior, demotion/rollback, and content-free support procedures.

## 8. Verify The Real Cross-Client Product Journey

- [x] 8.1 Add an end-to-end harness sharing the Exomem plugin acceptance fixture/run identity and asserting exact database plus fake/real provider resource counts.
- [ ] 8.2 Prove a clean invited identity completes one uninterrupted authorization, observes safe preparing behavior, then reaches seeded content, citation, governed capture, and fresh-chat recall from the real Claude client without configuration or Exomem-specific prompting.
- [ ] 8.3 Prove the same journey from the real OpenAI client and prove separately authorizing both clients attaches their token families to one tenant/cell/volume with no repeated login during valid refresh continuity.
- [ ] 8.4 Run duplicate/concurrent callback, expired/replayed invite, capacity exhaustion, delayed/terminal provisioning, stale discovery, cell mismatch, refresh replay, revocation, suspension/resume, deletion, restart, and concurrent two-tenant sentinel tests within recorded latency/resource budgets.
- [ ] 8.5 Run migrations from the prior production schema, focused and full tests, lint/typecheck/build, strict OpenSpec validation, and the deployed smoke checks; complete an independent security review and verifier pass before promoting the MCP contract.
