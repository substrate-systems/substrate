# Verification — Exomem hosted service

Verified on 2026-07-12 in the isolated Substrate worktree.

## Scorecard

| Dimension    | Result                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completeness | 43/44 tasks complete; paid Paddle sandbox drill is the only open task                                                                               |
| Correctness  | 44/44 requirements and 97 scenarios are implemented; paid billing code is covered by deterministic tests, while its real sandbox drill remains open |
| Coherence    | Shared Substrate control plane, provider-neutral isolated cells, product-scoped access, and internal entitlements follow the approved design        |

## Evidence

- Full suite: `npm test` — **391 passed, 0 failed, 0 skipped** across 95 suites, including existing Endstate behavior.
- Real PostgreSQL contracts: the hosted database, migration-runner concurrency, and `0019` upgrade fixtures — **12 passed** against a fresh migrated database.
- Type checking: `npx tsc --noEmit` — clean.
- Production build: `npm run build` — exit 0; every authenticated/token-bearing Exomem route is dynamic. The build's static Endstate JWKS probe logged the expected `DATABASE_URL is not set` message because no production database environment was injected.
- Formatting: all changed hosted files pass Prettier. Two pre-existing legacy files are not globally Prettier-clean; each received one scoped line without reformatting the surrounding file. `git diff --check` is clean.
- Local two-cell evidence is deterministic and composite: the lifecycle drill provisions distinct cells, suspends/resumes one, exports/restores it, rotates its credential, deletes it, and proves the neighbor stays ready; gateway/transfer/access suites independently cover two-owner capture/recall routing, identical keys/paths, transfer replay, invite races, and sentinel isolation.
- Gateway/cell contract is pinned to the Exomem fixture digest `983c4447f77ef31c1109b565e0149e053d222d87adabb84d5b3bc3581d1dfee2` with 21 registry-derived commands.
- Strict OpenSpec validation: `openspec validate add-exomem-hosted-service --strict --no-interactive` — valid.

## Security review closures

- Public identity resolves tenant and cell before command arguments; reserved selectors and trusted headers fail closed.
- Command JSON and transfer streams are byte-bounded even without `Content-Length`; private responses are bounded and idle-timed.
- Invite, access, session, deletion, and transfer bearer material is stored as digests or encrypted envelopes and kept out of logs and URLs.
- Magic-link generations, tenant creation, active-cell binding, lifecycle leases, restore pins, migration runners, and Paddle event projection use atomic PostgreSQL boundaries.
- Paddle checkout retries bind one authoritative transaction; webhook projection requires trusted owner/tenant/provider correlation and is idempotent and monotonic.
- Deletion cannot advance until billing termination is proven, and a retry recognizes an already-terminated Paddle state without depending on another provider call.
- Private Home surfaces are dynamic, noindex, no-store, and excluded from analytics on direct loads and client-side navigation.

## Paid launch gate

Paddle sandbox product `pro_01kxatbjfrehbp0sxbjefcacqs` (`Exomem Hosted`) is active and environment-selected, with no prices. Checkout therefore fails closed while complimentary alpha remains independent and ready. Task 9.4 intentionally remains open until an amount, currency, and billing interval are approved; only then can a real sandbox checkout/webhook/duplicate/out-of-order/cancel/portal reconciliation drill be run.

## OpenSpec verification assessment

### CRITICAL

- Task 9.4 is incomplete: a real Paddle sandbox checkout lifecycle cannot be exercised without an approved price. Create the sandbox price after product approval, configure its environment-selected ID, run the full checkout/webhook/reconciliation/portal/cancel drill, then mark the task complete.

### WARNING

- None.

### SUGGESTION

- None. The explicit production gates below are deployment inputs, not implementation divergences.

**Final assessment:** one external critical gate remains before this change can be archived as paid-launch complete. The complimentary invite-only alpha implementation is coherent and independently deployable without Paddle runtime access.

## Production gates

Before real invites, configure and drill the production HTTP provisioner, object storage/KMS, email, retention/deletion policy, cron, private network, and live secrets. Before paid live launch, additionally approve pricing, terms/tax handling, live Paddle catalog/webhook/domain configuration, and the real sandbox billing drill above.
