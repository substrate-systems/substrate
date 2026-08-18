## Context

Every admission predicate in the system gates on
`EXISTS (SELECT 1 FROM exomem_hosted_alpha_cohort …)`. That view inner-joins a live
`claude` artifact and a live `openai` artifact, the latter keyed to a registered
`asdk_app_*`. The consequence is that no Claude client can be admitted until an OpenAI app
exists, and the OpenAI app does not exist: `/.well-known/openai-apps-challenge` returns 404,
so the domain proof has not even been issued.

The approved spec for `admit-cimd-clients-by-host` already says admission requires "a live
cohort exists for the client's platform". No per-platform cohort exists in the schema, so
that requirement was implemented as the paired one.

Promotion is separately strict: `promoteExomemHostedCohort` takes both artifact IDs, and
its validation requires every routable cell to match the promoted candidate —
`(SELECT count(*) FROM cells) = (SELECT count(*) FROM exomem_routable_cell_contracts WHERE routable = true)`
plus a `NOT EXISTS` over any differing cell. So a live Claude artifact is unreachable
without a paired OpenAI client run.

## Goals / Non-Goals

**Goals:**

- Judge a client against its own platform's cohort, as the CIMD spec already requires.
- Make a single-platform cohort promotable so an invite-only alpha can launch on Claude.
- Keep paired promotion available and unchanged when two platforms are promoted together.
- Change no other admission condition: PKCE S256, redirect validation, auth-method
  normalisation, SSRF protection and metadata expiry all stay exactly as they are.

**Non-Goals:**

- Admitting a client with no promoted artifact for its platform. A live artifact for the
  requesting platform remains mandatory.
- Making ChatGPT or Codex work. ChatGPT still needs the registered app; Codex additionally
  needs RFC 7591 dynamic client registration. Neither is unblocked here.
- Relaxing what clean-client evidence must contain for the platform being promoted.

## Decisions

### A per-platform projection rather than loosening the paired view

The paired view is retained unchanged for the paired promotion path and for reporting. A
new projection expresses "this platform has a live artifact against a live candidate",
carrying platform, artifact id, and `oauth_client_config_sha256`. The two platform joins
differ in shape and both must be preserved: the Claude join matches package, archive,
compatibility, contract and plugin version against `claude_package_lock`/`claude_archive_lock`,
while the OpenAI join additionally requires `contract_candidate_id` and
`registered_app_id_sha256`. Rewriting the paired view in terms of the new one was rejected
as a needless change to a load-bearing predicate.

### Evidence is required for the platform being promoted, and only that platform

Single-platform promotion requires the same clean-client evidence for its own platform that
paired promotion requires. The cross-client checks — `paired_run_hmac_sha256`,
`exomem_identity_hmac_sha256`, `tenant_hmac_sha256` equality — are meaningful only when two
platforms are promoted together, and remain enforced in exactly that case. They are not
weakened; they become inapplicable when there is no second client.

### Routable-cell strictness is untouched

The requirement that every routable cell match the promoted candidate is unrelated to
platform coupling and stays as is. It is the reason the fleet must be homogeneous before a
promotion, and that property is worth keeping.

## Risks / Trade-offs

- **A Claude-only cohort goes live having proven one platform** → Accepted deliberately for
  an invite-only alpha. The two-platform claim becomes a marketplace-launch gate, which is
  what it was always really protecting.
- **A future reader assumes admission was weakened** → The proposal separates the defect
  from the product decision explicitly, and the runbook is updated to state which gate is
  which.
- **Per-platform predicates drift apart across six call sites** → Express the predicate once
  as server-side state readable by every admission query, as `admit-cimd-clients-by-host`
  already required for the host allowlist.
- **A promoted single-platform cohort is later paired** → Promotion must be idempotent and
  must not require retiring the existing platform's artifact to add the second.

## Migration Plan

1. Add the per-platform projection; no destructive change to the paired view.
2. Move the six admission predicates onto it, with integration coverage proving a Claude
   client is admitted with no OpenAI artifact present, and that an OpenAI client is *not*.
3. Allow single-platform promotion; keep paired promotion behaviour identical.
4. Update the runbook to distinguish the admission gate from the marketplace-launch gate.

Rollback: the paired view is retained, so reverting the predicates restores prior behaviour
without a data migration.

## Open Questions

- Should a single-platform promotion record which platforms it proved, so a later
  marketplace claim can assert the paired gate was met rather than inferring it?
- Does `hasLiveHostedCohortTarget`, used to pin a contract at provisioning time, want any
  live cohort or specifically one matching the tenant's intended client platform?
