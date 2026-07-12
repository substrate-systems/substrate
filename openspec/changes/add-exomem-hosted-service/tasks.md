## 1. Product-Scoped Data And Security Foundations

- [ ] 1.1 Add migration `0017_exomem_hosted_service.sql` for invites, access tokens, sessions, tenants, cells, entitlements, lifecycle operations, transfer grants, Paddle events, and content-free audit records with the required uniqueness and state constraints.
- [ ] 1.2 Add typed Exomem-hosted database queries and atomic transactions for invite redemption, owner-to-tenant resolution, active-cell binding, session revocation, entitlement projection, and leased operation claiming.
- [ ] 1.3 Add secret-digest, constant-time validation, envelope encryption, opaque principal scope, CSRF, and allowlisted content-free logging helpers with deterministic test seams.
- [ ] 1.4 Add adversarial tests for concurrent one-tenant creation, one-active-cell enforcement, session/token digest storage, credential redaction, and sensitive-sentinel log exclusion.

## 2. Invite And Session Access

- [ ] 2.1 Implement operator-authenticated invite creation with normalized email binding, complimentary/paid intent, expiration, rate limits, and delivery through the existing email adapter.
- [ ] 2.2 Implement atomic invite redemption that burns the token, resolves/creates shared identity, resolves/creates one Exomem tenant and entitlement, creates a product session, and enqueues provisioning.
- [ ] 2.3 Implement Exomem session resolution, rotation, expiration, logout, same-origin/CSRF mutation protection, and product-scoped cookie behavior independent of Endstate sessions.
- [ ] 2.4 Implement non-enumerating returning-user magic-link request and single-use redemption without public self-signup.
- [ ] 2.5 Add invite, replay, expiration, email override, concurrent redemption, cross-product session, CSRF, sign-out, enumeration, and sensitive-log tests.

## 3. Provider-Neutral Entitlements And Paddle

- [ ] 3.1 Implement one effective entitlement evaluator for complimentary, Paddle, grace, paused, cancelled, manually suspended, and deleted states with explicit capability/resource bundles.
- [ ] 3.2 Add Exomem checkout and customer-portal adapters that select sandbox/live and price/product configuration server-side and attach trusted product/user/tenant correlation metadata.
- [ ] 3.3 Extend the verified Paddle webhook dispatcher with idempotent Exomem product routing, monotonic event handling, entitlement projection, and unchanged Endstate behavior.
- [ ] 3.4 Add periodic Paddle reconciliation hooks without placing Paddle calls in normal capture, recall, Home, transfer, or cell-readiness execution.
- [ ] 3.5 Add tests for complimentary alpha, arbitrary-price rejection, missing catalog, duplicate/out-of-order events, manual-suspension precedence, grace policy, sandbox/live separation, and Endstate regression.

## 4. Cell Control Plane And Reconciler

- [ ] 4.1 Define the provider-neutral `CellProvisioner` contract and implement authenticated idempotent HTTP and deterministic fake adapters.
- [ ] 4.2 Implement provision, health, credential rotation, quiesce, resume, stop, export, restore, seal, and destroy lifecycle operations with durable checkpoints and stable codes.
- [ ] 4.3 Implement leased reconciliation with bounded retry/backoff, lost-acknowledgement convergence, stale-lease takeover, and terminal configuration failure handling.
- [ ] 4.4 Require expected cell identity, protocol, release, mutation authority, and worker policy from private readiness before binding or routing a cell.
- [ ] 4.5 Add authenticated cron/reconcile and owner-visible content-free status routes.
- [ ] 4.6 Add control-plane tests for duplicate provision, process interruption, concurrent reconcilers, wrong-cell readiness, unavailable cells, credential rotation, suspension/resume, and no alternate-cell fallback.

## 5. Registry-Derived Gateway And Transfers

- [ ] 5.1 Add the versioned Exomem contract fixture/client/cache and compatibility negotiation without a hand-copied command registry.
- [ ] 5.2 Implement authenticated `/api/exomem/commands/[command]` routing that resolves identity-to-cell first, rejects reserved selectors/headers, evaluates entitlements, and preserves Exomem envelopes/codes.
- [ ] 5.3 Implement private forwarding with unique cell authentication, matching trusted cell/protocol/request/principal context, bounded same-cell retries, and mutation-only idempotent replay.
- [ ] 5.4 Implement signed tenant-bound upload/download grants with audience, operation, cell, principal, expiry, jti, and resource limits plus content-free grant audit.
- [ ] 5.5 Implement streaming public upload/download routes that re-resolve the current mapping, enforce grant/limits, and never disclose private cell credentials, endpoints, or unauthorized file existence.
- [ ] 5.6 Add two-cell conformance tests for identical paths/titles/keys, selector and trusted-header attacks, cross-cell credentials, retry isolation, unavailable cells, transfer replay/scope/expiry, and sensitive sentinel exclusion.

## 6. Exomem Home And Onboarding

- [ ] 6.1 Build noindex invite acceptance, preparing, first-memory, ready, degraded, suspended, deletion-pending, and deleted states with accessible responsive layouts.
- [ ] 6.2 Implement the first capture and immediate recall journey using registry-backed `remember` and `ask_memory`, safe defaults, stable idempotency, and plain-language error recovery.
- [ ] 6.3 Add the ready workspace with primary capture/recall plus progressively disclosed recent memory, review/connections, upload, service status, export, billing, sign-out, and deletion controls.
- [ ] 6.4 Ensure authenticated Home content is excluded from analytics, static generation, shared caches, request URLs, and content-bearing telemetry.
- [ ] 6.5 Add component/route tests for non-technical onboarding, retry-safe capture, warming lexical recall, empty/degraded states, entitlement-gated secondary actions, keyboard/mobile behavior, and sensitive-content privacy.

## 7. Export, Restore, And Product-Scoped Deletion

- [ ] 7.1 Implement asynchronous verified export orchestration through quiesce, cell manifest verification, tenant-scoped encrypted object storage, resume, and short-lived owner download.
- [ ] 7.2 Implement staged replacement-cell restore with archive verification, readiness proof, atomic active binding swap, and failed-restore preservation of the prior cell.
- [ ] 7.3 Implement fresh emailed deletion confirmation, Exomem session/transfer revocation, routing suspension, policy-driven final export, cell seal, external storage/key destruction, and verified completion.
- [ ] 7.4 Add tests for export retry/interruption, corrupt manifest, restore rollback, object isolation, partial destruction, deletion replay, minimum audit retention, and preservation of Endstate/shared identity data.

## 8. Configuration, Documentation, And Catalog

- [ ] 8.1 Document and validate Exomem session/admin secrets, control-plane encryption key, provisioner endpoint/credential, cell release/protocol, database, object storage, cron, email, and sandbox/live Paddle configuration.
- [ ] 8.2 Add operator runbooks for invite issuance, provisioning recovery, suspension, credential rotation, export/restore, deletion, two-cell incident isolation, and rollback.
- [ ] 8.3 Document the honest encryption/privacy ceiling, canonical export ownership, content-free observability, complimentary alpha policy, and Paddle runtime non-dependency.
- [ ] 8.4 Configure the Paddle sandbox Exomem catalog and webhook contract through environment-selected IDs; keep live checkout disabled until explicit price and launch gates are approved.

## 9. Verification And Alpha Handoff

- [ ] 9.1 Run focused access, database, entitlement, Paddle, control-plane, gateway, transfer, Home, export/restore, deletion, and privacy tests.
- [ ] 9.2 Run formatting, type checking/build, full test suite, and strict OpenSpec validation with no Endstate behavior regressions.
- [ ] 9.3 Run a local two-cell lifecycle drill from two invites through independent capture/recall, retry, transfer, suspend/resume, export/restore, credential rotation, and deletion while proving sentinel isolation.
- [ ] 9.4 Run Paddle sandbox checkout/webhook/duplicate/out-of-order/cancel/portal reconciliation against a test entitlement without exposing provider IDs to a cell.
- [ ] 9.5 Record verification evidence, review every security-boundary diff, leave production provisioner/retention/price gates explicit, and keep complimentary alpha ready without requiring live billing.
