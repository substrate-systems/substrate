# Verification — Exomem hosted service

Verified on 2026-07-13 in the isolated Substrate worktree.

## Scorecard

| Dimension    | Result                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Completeness | 46/46 tasks complete, including the real Paddle sandbox lifecycle drill                                                                    |
| Correctness  | 46/46 requirements and 111 scenarios are implemented; 445 repository tests and 22 real-PostgreSQL tests pass                               |
| Coherence    | Shared Substrate control plane, provider-neutral isolated cells, owner-bound billing, and product-scoped lifecycle follow the final design |

## Repository evidence

- Full suite: `npm test` — **445 passed, 0 failed, 0 skipped** across 100 suites, including existing Endstate behavior.
- Real PostgreSQL contracts: migration-runner concurrency, `0019`, `0020`, and `0021` upgrade fixtures, and hosted SQL/race contracts — **22 passed, 0 failed, 0 skipped** across 5 suites against a fresh database migrated through `0021`. The billing/deletion race test held a concurrent entitlement promotion lock, proved the atomic deletion transition blocked, then proved stale billing evidence could not advance the lifecycle checkpoint. It also delivered a verified post-scrub webhook and proved the removed reference could not be reattached.
- Type checking: `npx tsc --noEmit` — clean.
- Production build: `npm run build` — exit 0; every authenticated/token-bearing Exomem route is dynamic. Static generation logged the expected existing hosted-backup JWKS error because `DATABASE_URL` was intentionally not injected.
- Formatting: every changed Markdown, TypeScript, and TSX file passes Prettier; `git diff --check` is clean.
- Local two-cell evidence is deterministic and composite: the lifecycle drill provisions distinct cells, suspends/resumes one, exports/restores it, rotates its credential, deletes it, and proves the neighbor stays ready; gateway, transfer, and access suites independently cover two-owner capture/recall routing, identical keys/paths, transfer replay, invite races, and sentinel isolation.
- Gateway/cell contract remains pinned to the Exomem fixture digest `983c4447f77ef31c1109b565e0149e053d222d87adabb84d5b3bc3581d1dfee2` with 21 registry-derived commands.
- Strict OpenSpec validation: `openspec validate --all --strict --no-interactive` — **17 passed, 0 failed**.

## Real Paddle sandbox evidence

- The active `Exomem Hosted` sandbox product is `pro_01kxatbjfrehbp0sxbjefcacqs`; its approved friends tier is `pri_01kxd05eg20ezcy2ecvrcwv3a6`, EUR 5 monthly.
- The account-level default payment link and sandbox checkout domain were already configured and were verified directly.
- A real transaction completed through checkout, created the correlated customer/subscription, opened the customer portal, paused, resumed, and canceled. The final provider state remained canceled.
- Signed webhook deliveries were applied to real PostgreSQL. Duplicate events converged idempotently, older observations could not replace newer state, and invalid owner/tenant/provider correlation failed closed.
- Provider-snapshot reconciliation observed a stale revision without reopening the canceled entitlement.
- Disposable sandbox notification settings, simulation artifacts, and client credentials created for the drill were removed. No customer, transaction, subscription, credential, or webhook secret is retained in the repository.

## Security review closures

- Public identity resolves tenant and cell before command arguments; reserved selectors and trusted headers fail closed.
- Command JSON and transfer streams are byte-bounded even without `Content-Length`. Private response reads are bounded, unsuccessful bodies are canceled, body-transport resets retry only against the same cell/request identity, and one absolute deadline covers all attempts.
- Invite, access, session, deletion, and transfer bearer material is stored as digests or encrypted envelopes and kept out of logs and URLs.
- Magic-link generations, tenant creation, active-cell binding, lifecycle leases, restore pins, migration runners, and Paddle event projection use atomic PostgreSQL boundaries.
- Checkout binding serializes with deletion. A returned `_ptxn` is removed from browser history and must pass an authenticated, CSRF-protected, exact owner/tenant binding check before Paddle.js opens it. The candidate remains only in session-scoped storage until checkout actually opens; validation and Paddle initialization failures surface explicit retry/dismiss controls, and reload retry revalidates the scrubbed return.
- Canceled transactions are compare-and-cleared before replacement. Authenticated returns for canceled transactions settle back to Home without opening Paddle.js. Completed returns promote their subscription/customer, schedule and attempt immediate reconciliation, settle back to Home, and never create a second checkout. Both terminal paths use transaction-only merchant configuration and remain recoverable after current browser, public-origin, or sale-catalog settings rotate; draft/ready returns still require the full current checkout, catalog, and URL checks.
- Paddle environment provenance is persisted with provider references. Legacy rows are backfilled only from exact receipts or verified webhooks; unresolved references are frozen while local lifecycle gating remains possible, and unresolved or mismatched provenance blocks provider calls rather than guessing. Even a provider-cancelled source state requires an exact stored/configured environment match; only the durable local `deletion_cancelled` marker replays without provider configuration.
- Deletion cancels an exact pending transaction or its discovered completed subscription before cell destruction, independently of the currently saleable price. Provider `404` is unverified because it can mean a wrong merchant account. Provider termination returns an exact proof snapshot without writing state; one PostgreSQL CTE then locks operation, tenant, and entitlement, compares the complete fingerprint, marks billing terminated, scrubs the dead provider references, and advances the leased/fenced lifecycle checkpoint atomically. The real lock-race test proves a concurrent promotion cannot slip between proof and checkpoint or reattach through the scrubbed reference.
- Private Home surfaces are dynamic, noindex, no-store, and excluded from analytics on direct loads and client-side navigation.

## OpenSpec verification assessment

### CRITICAL

- None.

### WARNING

- None.

### SUGGESTION

- None. The production gates below are deployment inputs, not implementation divergences.

**Final assessment:** the change is implementation-complete and coherent. The complimentary alpha and EUR 5 friends-tier sandbox path are ready; production deployment still requires the explicit infrastructure and live-commercial inputs below.

## Production gates

Before real invites, configure and drill the production HTTP provisioner, object storage/KMS, email, retention/deletion policy, cron, private network, and live secrets. Before paid live launch, select the exact public price within EUR 10–15, approve terms/tax handling, and configure the live Paddle product/price, webhook, credentials, and checkout domain. Keep the EUR 5 friends price distinct from the future public tier.
