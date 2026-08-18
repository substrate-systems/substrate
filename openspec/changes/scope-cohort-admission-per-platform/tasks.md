## 1. Sequencing

- [ ] 1.1 Confirm `admit-cimd-clients-by-host` archives before this change applies, since the `exomem-hosted-mcp-oauth` delta modifies a requirement that capability introduces and which is not yet in `openspec/specs/`

## 2. Per-platform cohort state

- [ ] 2.1 Add a migration projecting a per-platform cohort carrying platform, live artifact id, candidate id, and `oauth_client_config_sha256`, preserving each platform's distinct join shape
- [ ] 2.2 Retain `exomem_hosted_alpha_cohort` unchanged for the paired path and reporting
- [ ] 2.3 Prove in an integration test that the projection reports `claude` live with no OpenAI artifact present, and does not report `openai`

## 3. Admission predicates

- [ ] 3.1 Move all six predicates in `oauth-store.ts` onto the per-platform projection, judging each client against its own `client_platform`
- [ ] 3.2 Scope the CIMD admitted-host branch to the client's own platform, as `admit-cimd-clients-by-host` already specified
- [ ] 3.3 Update `account-install-actions.ts` and `reviewer-access-store.ts` to the same predicate
- [ ] 3.4 Decide and implement `hasLiveHostedCohortTarget`'s semantics for provisioning (see design Open Questions)
- [ ] 3.5 Integration tests: a Claude client is admitted with only a Claude cohort; an OpenAI client is refused; an admitted-host client is refused when its own platform has no cohort
- [ ] 3.6 Confirm no other admission condition changed — PKCE S256, redirect validation, auth-method normalisation, metadata expiry, SSRF protection

## 4. Single-platform promotion

- [ ] 4.1 Accept the set of platforms being promoted rather than requiring both artifact IDs
- [ ] 4.2 Require the same clean-client evidence for each promoted platform that paired promotion requires
- [ ] 4.3 Enforce cross-client HMAC equality only when two platforms are promoted together, unchanged in that case
- [ ] 4.4 Allow adding a second platform to an already-live candidate without retiring the first
- [ ] 4.5 Leave routable-cell strictness untouched: every routable cell must still match the promoted candidate
- [ ] 4.6 Integration tests for single-platform promotion, failed evidence, paired promotion cross-check, and later pairing

## 5. Documentation

- [ ] 5.1 Update `docs/runbooks/exomem-hosted-alpha.md` with the single-platform promotion path
- [ ] 5.2 State plainly which gate is which: a live cohort for the platform is the admission gate; paired clean-client evidence is the marketplace-launch gate

## 6. Ship the alpha on Claude

- [ ] 6.1 Clear the routable set: destroy or roll forward tenant `1809ce5c`, whose binding operation targeted 0.50.0 and which therefore cannot satisfy a 0.54.1 promotion
- [ ] 6.2 Land the destroy-path `routable` clear first if destroying, so the dead cell does not become a promotion-blocking ghost
- [ ] 6.3 Provision a fresh tenant so its binding operation names the 0.54.1 candidate `eb88eedb-7f18-4aeb-b02e-c670772c76d5`, and confirm it is the only routable cell
- [ ] 6.4 Record one clean real Claude client run and its signed evidence
- [ ] 6.5 Promote the Claude-only cohort and confirm `liveCohortCandidateId` is no longer null
- [ ] 6.6 Verify a fresh invited tenant can connect Claude and save a memory before inviting anyone
