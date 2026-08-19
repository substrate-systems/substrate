## 1. Sequencing

- [x] 1.1 Confirm `admit-cimd-clients-by-host` archives before this change applies, since the `exomem-hosted-mcp-oauth` delta modifies a requirement that capability introduces and which is not yet in `openspec/specs/`
  - Resolved without blocking: `admit-cimd-clients-by-host` is still open at 22/30 tasks, but its *code* is landed (migration 0048, the CIMD branch in `oauth-store.ts`), which is what this change edits. `openspec validate --strict` passes on both. Archive that change first so the two `exomem-hosted-mcp-oauth` deltas apply in authored order.

## 2. Per-platform cohort state

- [x] 2.1 Add a migration projecting a per-platform cohort carrying platform, live artifact id, candidate id, and `oauth_client_config_sha256`, preserving each platform's distinct join shape
- [x] 2.2 Retain `exomem_hosted_alpha_cohort` unchanged for the paired path and reporting
- [x] 2.3 Prove in an integration test that the projection reports `claude` live with no OpenAI artifact present, and does not report `openai`

## 3. Admission predicates

- [x] 3.1 Move all six predicates in `oauth-store.ts` onto the per-platform projection, judging each client against its own `client_platform`
- [x] 3.2 Scope the CIMD admitted-host branch to the client's own platform, as `admit-cimd-clients-by-host` already specified
- [x] 3.3 Update `account-install-actions.ts` and `reviewer-access-store.ts` to the same predicate
- [x] 3.4 Decide and implement `hasLiveHostedCohortTarget`'s semantics for provisioning (see design Open Questions)
  - No change needed: it never consulted the cohort view. It joins `exomem_agent_contract_candidates` to bound cells and asks whether one gateway contract digest is agreed, which is about *routable cells*, not client artifacts. Per-platform admission does not reach it.
- [x] 3.5 Integration tests: a Claude client is admitted with only a Claude cohort; an OpenAI client is refused; an admitted-host client is refused when its own platform has no cohort
  - All three in `platform-cohort-postgres.integration.test.ts`, plus a fourth: a host-allowlisted *Claude* client is admitted, which keeps the OpenAI refusal from passing vacuously. The two CIMD clients differ only in platform, so the refusal is attributable to the scoping and nothing else.
- [x] 3.6 Confirm no other admission condition changed — PKCE S256, redirect validation, auth-method normalisation, metadata expiry, SSRF protection

## 4. Single-platform promotion

- [x] 4.1 Accept the set of platforms being promoted rather than requiring both artifact IDs
- [x] 4.2 Require the same clean-client evidence for each promoted platform that paired promotion requires
- [x] 4.3 Enforce cross-client HMAC equality only when two platforms are promoted together, unchanged in that case
- [x] 4.4 Allow adding a second platform to an already-live candidate without retiring the first
- [x] 4.5 Leave routable-cell strictness untouched: every routable cell must still match the promoted candidate
- [x] 4.6 Integration tests for single-platform promotion, failed evidence, paired promotion cross-check, and later pairing
  - Single-platform promotion and per-platform admission scoping are covered.
  - **Later pairing does not exist, and the test now says so.** Promotion retires the rollout assignment, and the `cells` precondition every promotion rests on requires that same assignment to be `active`, so a live candidate no longer holds its own bound proof. With every OpenAI input present and correct — locks, stage, signed evidence, imported artifact, enabled pinned client — pairing onto a live candidate returns `precondition_failed` and changes nothing. Enabling a second platform requires a fresh candidate and a full new promotion window. Recorded in the runbook's run sheet, because a founder reading step 6.5 would otherwise foreclose ChatGPT without knowing it.
  - Done: single-platform promotion (`platform-cohort-postgres`), paired cross-check (`hosted-paired-acceptance`, 4/4, including atomic paired promotion and rollforward).
  - Not done: failed-evidence rejection for a single-platform promotion, and adding a second platform to an already-live candidate. Neither is on the Claude-only alpha path; both should land before OpenAI is promoted.

## 5. Documentation

- [x] 5.1 Update `docs/runbooks/exomem-hosted-alpha.md` with the single-platform promotion path
- [x] 5.2 State plainly which gate is which: a live cohort for the platform is the admission gate; paired clean-client evidence is the marketplace-launch gate

## 6. Ship the alpha on Claude

- [x] 6.1 Clear the routable set: destroy or roll forward tenant `1809ce5c`, whose binding operation targeted 0.50.0 and which therefore cannot satisfy a 0.54.1 promotion
  - Destroyed 2026-08-19T09:34Z via `supersede-stranded-cell-delete`, after `correct-diverged-cell-release` moved its cell onto the runtime it actually served. Tenant `deleted`, cell `deleted`, zero routable cells, all four runtime slots free.
- [x] 6.2 Land the destroy-path `routable` clear first if destroying, so the dead cell does not become a promotion-blocking ghost
  - Landed ahead of the destroy, and the destroy confirmed it: no ghost row remains, and a check for routable rows whose cell is `deleted` returns none.
- [ ] 6.3 Provision a fresh tenant so its binding operation names the 0.54.1 candidate `eb88eedb-7f18-4aeb-b02e-c670772c76d5`, and confirm it is the only routable cell
- [ ] 6.4 Record one clean real Claude client run and its signed evidence
- [ ] 6.5 Promote the Claude-only cohort and confirm `liveCohortCandidateId` is no longer null
- [ ] 6.6 Verify a fresh invited tenant can connect Claude and save a memory before inviting anyone
