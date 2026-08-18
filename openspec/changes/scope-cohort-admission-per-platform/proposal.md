## Why

Exomem Hosted cannot admit a single Claude user until an OpenAI app is registered.

`exomem_hosted_alpha_cohort` inner-joins a live `claude` artifact **and** a live `openai`
artifact whose `registered_app_id_sha256` must match a real `asdk_app_*`. Every admission
predicate gates on `EXISTS (SELECT 1 FROM exomem_hosted_alpha_cohort …)`, so an empty
cohort admits nobody on either platform. The OpenAI side is at step zero: the domain proof
route `/.well-known/openai-apps-challenge` returns 404, so no app is registered and none
can be until OpenAI issues and verifies a challenge value.

The private alpha is invite-only and its invitees may only ever use Claude. Coupling
Claude admission to a third party's registration queue is blocking the launch for no
security benefit.

This change has two halves, and they are not the same kind of change.

**Half one is a defect.** The approved spec for `admit-cimd-clients-by-host` states that
admission "SHALL additionally require … that a live cohort exists for the client's
platform", with a scenario named "No live cohort exists for the platform". The
implementation nests that branch inside the whole-cohort `EXISTS`, so it requires a live
cohort for *both* platforms. There is no per-platform cohort in the schema at all, so the
requirement as written was never implementable and the stricter rule was substituted
silently.

**Half two is a deliberate product decision.** `promoteExomemHostedCohort` takes both a
`claudeArtifactId` and an `openaiArtifactId` and asserts their evidence HMACs name the same
cohort. So even with admission fixed, no live `claude` artifact can ever exist without a
paired OpenAI client run. Allowing a single-platform promotion genuinely relaxes a release
gate. It is proposed on the judgement that paired clean-client evidence is a *marketplace
launch* gate, not an *invite-only private alpha* gate.

## What Changes

- Add a per-platform cohort projection so "a live cohort exists for this platform" becomes
  expressible, carrying the platform, its live artifact, and its `oauth_client_config_sha256`.
- Re-express the admission predicates so a client is judged against its **own** platform's
  cohort. A Claude client is admitted on the strength of the Claude artifact; an OpenAI
  client on the OpenAI artifact. The CIMD host-allowlist branch is scoped the same way,
  which is what its spec already required.
- Allow promotion of a single-platform cohort, with evidence required for exactly the
  platform being promoted. **BREAKING** for the release process, not for any wire contract:
  a promotion may now establish a Claude-only cohort.
- Preserve paired promotion as a distinct, still-supported path, and keep the cross-client
  HMAC equality checks whenever two platforms are promoted together.
- Keep provisioning's contract pin (`hasLiveHostedCohortTarget`) satisfied by any live
  cohort, so a Claude-only cohort is sufficient to provision a tenant.

## Capabilities

### New Capabilities

- `hosted-platform-cohort`: what it means for a cohort to be live for one platform, how a
  single-platform cohort is promoted and what evidence it requires, and the guarantee that
  one platform's cohort never admits another platform's client.

### Modified Capabilities

- `exomem-hosted-mcp-oauth`: admission is evaluated against the client's own platform
  cohort, making the implementation match the requirement already stated for
  host-allowlisted CIMD clients.

## Impact

**Security-relevant, and the widening must be understood precisely.** Admission still
requires a live, promoted artifact for the requesting client's platform, still requires
PKCE S256, still validates redirect URIs, and still normalises
`token_endpoint_auth_method`. What is removed is the requirement that a *different*
platform also have a live artifact — a condition that never described the requesting
client. What is genuinely relaxed is the promotion gate: a cohort may now go live having
proven one platform rather than two.

- `migrations/`: a new per-platform cohort view. No destructive change; the paired view is
  retained for the paired promotion path and existing reporting.
- `src/lib/exomem-hosted/oauth-store.ts`: six admission predicates.
- `src/lib/exomem-hosted/agent-contract-store.ts`: `promoteExomemHostedCohort`,
  `getLiveExomemHostedCohortCandidateId`.
- `src/lib/exomem-hosted/account-install-actions.ts`, `reviewer-access-store.ts`,
  `hosted-cohort-target.ts`.
- `docs/runbooks/exomem-hosted-alpha.md`: the promotion procedure gains a single-platform
  path, and the two-platform claim becomes a marketplace-launch gate rather than an
  admission prerequisite.
- PostgreSQL integration suites covering admission and promotion.
