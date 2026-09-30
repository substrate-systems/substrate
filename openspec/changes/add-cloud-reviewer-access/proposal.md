## Why

Directory reviewers must authenticate to the dedicated sample Cloud vault without access to its owner's inbox. Cloud's email-link sign-in cannot provide that, and its retired Hosted reviewer branch is intentionally disabled.

## What Changes

- Add expiring, provider-bound reviewer access for explicitly marked sample Cloud tenants through the existing OAuth/session service.
- Keep Hosted provider-review/canary credentials unusable on the Cloud resource; do not restore cohort, candidate or client-artifact authority.
- Reuse the existing reviewer disclosure/form, credential hashing and OAuth lineage; enforce expiry and revocation through browser sessions, codes, grants and tokens, and deny reviewer billing mutations.
- Preserve an invitation's immutable sample purpose during initial Cloud admission and require purpose equality during re-admission; never convert an existing ordinary account.
- Add operator-only issuance/status/rotation/revocation and real PostgreSQL plus browser acceptance.

## Capabilities

### New Capabilities

- `exomem-cloud-reviewer-access`: isolated, expiring reviewer authentication and OAuth authorization for directory review.

### Modified Capabilities

None. The pending `adopt-exomem-cloud-plain-cells` delta will be reconciled to distinguish retired Hosted credentials from the new Cloud-only credential kind.

## Impact

Substrate's existing credential table, reviewer admin/redemption routes, OAuth access checks, session classification and authorization page. An additive migration changes credential-kind constraints. Cloud admission gains correct sample-purpose propagation, and Cloud reviewer sessions cannot open checkout/customer portals. No new authentication backend, normal-user password login, cell provisioning mechanism, cohort or runtime changes. Exomem's distribution and Cloud release batches remain separate dependencies.
