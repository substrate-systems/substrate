## 1. Lock The Recovery Boundary

- [x] 1.1 Add red-first PostgreSQL tests for the exact expired- or terminal-failed-reviewer/unbound-cleanup transition; the separate exact replay branch; full Hosted/reviewer/OAuth revocation; principal-bound source/result audit receipt; and no mutation on stale fence, live lease, bound/ambiguous cell, eligible assignment, live authority, customer tenant, terminal state other than exact replay, or mismatched target
- [x] 1.2 Add a PostgreSQL concurrency test proving every reviewer/OAuth issuer serializes behind the exclusive cohort recovery lock and cannot commit usable authority after recovery
- [x] 1.3 Add red-first route tests for operator authentication, bounded exact-operation/fence input, read-only content-free preflight, stable refusal, and content-free success/replay responses

## 2. Implement The Atomic Transition

- [x] 2.1 Add the exclusive-cohort-locked operator-control transaction with separate initial/replay branches that validates the caller-pinned source operation and fence, revokes the union of owner and lifecycle deletion authority, increments the fence once, gates product state, supersedes lower-fence work, enqueues one derived-key target-free delete, and writes the durable principal-bound source/result audit receipt
- [x] 2.2 Add authenticated `preflight-recover-expired-reviewer-cleanup` and `recover-expired-reviewer-cleanup` contracts-admin actions; return only content-free outcomes and opaque operation/request identities
- [x] 2.3 Preserve ordinary owner deletion, ordinary reviewer bootstrap, v1/v2 operation selection, shared identity, and Endstate product data unchanged

## 3. Verify The Recovery Contract

- [x] 3.1 Prove the enqueued delete uses a strictly higher fence, normal target-free DESTROY, and cannot itself mark provider/control deletion or capacity release complete
- [x] 3.2 Update the Hosted alpha runbook with exact preflight, invocation, bounded reconcile, provider/control/capacity proof, and fresh-bootstrap ordering
- [x] 3.3 Run focused PostgreSQL/route/lifecycle tests, TypeScript, ESLint, production build, strict OpenSpec validation, and an independent security review
- [ ] 3.4 Commit, integrate current remote main, push, open a ready PR, merge only after required checks pass, and verify the production deployment before live recovery
