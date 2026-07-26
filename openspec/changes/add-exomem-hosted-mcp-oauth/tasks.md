## 1. Pin Protocol, Security, And Data Contracts

- [ ] 1.1 Add failing pure tests for protected-resource and authorization-server metadata, `WWW-Authenticate`, supported MCP negotiation, bearer-header-only authority, resource/audience binding, PKCE S256, exact redirect validation, and content-free OAuth errors.
- [ ] 1.2 Add failing pure tests for approved pre-registration/CIMD resolution, public-HTTPS and SSRF boundaries, fetch/cache/size/redirect limits, and bounded DCR compatibility with generic admission default-off.
- [ ] 1.3 Add failing pure tests for authorization-code single use, opaque access/refresh digests, client/resource/scope/family binding, atomic refresh rotation, replay-family revocation, and current entitlement/lifecycle enforcement.
- [ ] 1.4 Add migration `migrations/0025_exomem_mcp_oauth_capacity.sql` for authorization transactions/codes, grants/token families, approved or bounded client metadata, live/pending agent contracts, and multidimensional capacity reservations/occupancy with uniqueness, expiry, and deletion constraints.
- [ ] 1.5 Pin the official TypeScript MCP transport dependency and any narrowly required OAuth primitives, documenting why their protocol/security behavior is used instead of a handwritten transport parser.

## 2. Implement Exomem OAuth Discovery And Tokens

- [ ] 2.1 Implement bounded client identity resolution and cache/storage for operator-pinned clients, validated CIMD, and default-off per-host DCR compatibility.
- [ ] 2.2 Implement protected-resource and authorization-server metadata routes plus standards-correct unauthenticated/invalid-token challenges at the canonical Exomem MCP resource.
- [ ] 2.3 Implement sealed authorization transactions and the authorize route with client/redirect/resource/scope/state/PKCE binding and safe resumption through existing browser, invite, and magic-link identity.
- [ ] 2.4 Implement single-use code exchange, opaque short-lived access tokens, rotating refresh families, revocation, audience/scope checks, and raw-secret redaction.
- [ ] 2.5 Add route/integration tests for login resume, upstream identity-provider independence after grant creation, code interception/replay, refresh races/replay, per-client revocation, account-wide denial, and restart continuity.

## 3. Add Atomic First-Login Capacity Admission

- [ ] 3.1 Add failing database/integration tests for atomic invite validation plus capacity reservation, one identity/tenant/entitlement/grant/initial-provision operation, rollback on exhausted capacity, reusable invite on failure, and zero provider calls before commit.
- [ ] 3.2 Add concurrent tests for duplicate OAuth callbacks and first-login races proving exactly one reservation, tenant, entitlement, provision operation, cell, and volume.
- [ ] 3.3 Implement the admission transaction by extending the existing access/database boundary, while making existing entitled owners attach without another reservation or infrastructure operation.
- [ ] 3.4 Implement capacity-ledger transitions for reserved, occupied, uncertain, released, and retained-storage states plus globally bounded provisioning claims.
- [ ] 3.5 Extend lifecycle reconciliation and provisioner fakes for conservative lost-ack handling, release only after verified absence/destruction, suspension runtime release, and resume-time runtime reacquisition of the same cell.

## 4. Import And Promote The Exact Agent Contract

- [ ] 4.1 Extend `scripts/generate-exomem-hosted-contract.mjs` and fixtures to import the Exomem `hosted-alpha-agent-v1` contract, canonical tool schemas/descriptions/annotations, profile fingerprint, full schema digest, protocol range, and source release without a copied allowlist.
- [ ] 4.2 Add failing tests for deterministic import, pending/live atomic promotion, stale or incompatible candidate rejection, unchanged live discovery during rollout, and exact agreement with both Exomem package locks.
- [ ] 4.3 Implement contract storage/promotion and an operator-visible check that all routable cell releases expose the exact profile-specific private contract before a candidate becomes live.

## 5. Implement The Protected Streamable HTTP MCP Resource

- [ ] 5.1 Add failing transport tests for initialize, tools/list, tools/call, supported protocol versions, stateless or safely scoped MCP sessions, request cancellation/deadlines, and malformed or oversized messages.
- [ ] 5.2 Implement `src/app/api/exomem/mcp/route.ts` and the shared MCP adapter so authenticated initialize/tools/list are served from the live contract without a tenant cell call or wake.
- [ ] 5.3 Add failing gateway tests for exact token-to-identity-to-tenant-to-cell resolution, reserved-field rejection, entitlement/read-write scope checks, profile-only private forwarding, no bearer passthrough, and no full-route or cross-tenant fallback.
- [ ] 5.4 Implement canonical tools/call forwarding through the existing gateway and the cell's profile-specific private agent route, preserving canonical envelopes and scoped idempotency.
- [ ] 5.5 Add stable `TENANT_PREPARING`, capacity, provisioning-failed, suspended, deleted, not-ready, and incompatible-contract MCP result mappings with bounded retry timing and opaque support references.

## 6. Bound Cost, Abuse, And Telemetry

- [ ] 6.1 Add failing tests that plugin install, OAuth metadata/challenges, client metadata/registration, failed authentication, ineligible authorization, initialize, and tools/list create no tenant infrastructure or cell wake.
- [ ] 6.2 Enforce the 5 GiB usable storage, 90 MiB upload ceiling, and zero-worker alpha projection at admission/readiness while keeping excluded expensive commands absent from MCP.
- [ ] 6.3 Extend pre-auth IP and post-auth identity/client rate limiting with bounded request/response bytes, concurrent calls, retries, timeouts, and provision claims; add adversarial amplification tests.
- [ ] 6.4 Extend content-free observability and cost metrics for opaque client/cohort, reservations, storage occupancy, active runtime, provider operations, MCP calls/bytes/retries, latency, and stable errors.
- [ ] 6.5 Add sentinel leak tests spanning OAuth, MCP, gateway, capacity, lifecycle, provisioner, promotion evidence, responses, and logs.

## 7. Wire Private Distribution And Operations

- [ ] 7.1 Add invite/Home install actions for promoted Claude and OpenAI artifacts only, with no manual connector URL or tenant-specific package and no exposure to ineligible users.
- [ ] 7.2 Add operator controls for client admission, token-family/account revocation, contract promotion/demotion, capacity totals, provision concurrency, and safe cohort rollout.
- [ ] 7.3 Update `docs/runbooks/exomem-hosted-alpha.md` with OAuth keys/rotation, metadata routes, capacity accounting, preparing/failure diagnostics, suspension/resume behavior, demotion/rollback, and content-free support procedures.

## 8. Verify The Real Cross-Client Product Journey

- [ ] 8.1 Add an end-to-end harness sharing the Exomem plugin acceptance fixture/run identity and asserting exact database plus fake/real provider resource counts.
- [ ] 8.2 Prove a clean invited identity completes one uninterrupted authorization, observes safe preparing behavior, then reaches seeded content, citation, governed capture, and fresh-chat recall from the real Claude client without configuration or Exomem-specific prompting.
- [ ] 8.3 Prove the same journey from the real OpenAI client and prove separately authorizing both clients attaches their token families to one tenant/cell/volume with no repeated login during valid refresh continuity.
- [ ] 8.4 Run duplicate/concurrent callback, expired/replayed invite, capacity exhaustion, delayed/terminal provisioning, stale discovery, cell mismatch, refresh replay, revocation, suspension/resume, deletion, restart, and concurrent two-tenant sentinel tests within recorded latency/resource budgets.
- [ ] 8.5 Run migrations from the prior production schema, focused and full tests, lint/typecheck/build, strict OpenSpec validation, and the deployed smoke checks; complete an independent security review and verifier pass before promoting the MCP contract.
