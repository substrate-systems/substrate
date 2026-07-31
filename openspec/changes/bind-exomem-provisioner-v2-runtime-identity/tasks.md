## 1. Freeze And Review The Contract

- [x] 1.1 Correct the active Hosted OAuth/canary spec and design so cells report runtime identity only and package compatibility remains catalog-owned
- [x] 1.2 Validate all Substrate OpenSpec artifacts strictly and obtain paired Exomem/Substrate architecture review
- [x] 1.3 Freeze the v1 corpus hash and paired v2 corpus shape, including exact protocol headers

## 2. Add Migration 0037

- [x] 2.1 Add failing migration tests for v1 backfill/default, allowed values, v2 target completeness, the exact no-cell-delete exception, immutability, rolling-binary compatibility, and absence of control-plane/provider side effects
- [x] 2.2 Add `provisioner_wire_protocol` plus its v2 target constraint and narrow no-cell-delete exception without duplicating migration 0036 target or observation fields
- [x] 2.3 Update lifecycle row types/readers/writers so new operations persist a protocol and every cell-scoped operation snapshots a complete authoritative target before first issuance

## 3. Implement Strict Dual-Protocol Codecs

- [x] 3.1 Add failing provisioner tests for default-off v1, explicit v2, exact headers/bodies, mixed response rejection, and bounded errors
- [x] 3.2 Preserve exact v1 serializers/parsers and add strict v2 codecs, including required targets for cell-scoped calls and explicit target-free export-reference/tenant-destroy calls
- [x] 3.3 Include the selected wire protocol and canonical envelope in fake-provisioner idempotency identity
- [x] 3.4 Add the documented fail-closed v2 issuance environment setting and operations-contract coverage

## 4. Bind Existing Targets To Runtime Identity

- [x] 4.1 Add failing reconciler and lifecycle-store tests for complete target mapping on every operation with a cell, the no-cell-delete exception, target-free context calls, one-field mismatch, restart/retry stability, and runtime-only observation
- [x] 4.2 Populate existing migration 0036 target columns from assignment/live selection for provision/restore and authoritative bound-cell catalog state for all other cell-scoped actions without another hard-coded release mapping
- [x] 4.3 Compare strict v2 health only against `runtimeIdentity` and record gateway/command/schema measurements in existing observation columns
- [x] 4.4 Resolve compatibility and package/archive/plugin/OAuth lineage only through existing candidate and staged-client records
- [x] 4.5 Preserve offline recovery and destruction when live runtime health is unavailable

## 5. Share The Cross-Language Corpus

- [x] 5.1 Keep the v1 fixture byte-exact and add the exact paired v2 corpus or a SHA-pinned copy
- [x] 5.2 Assert protocol headers, all request/pending/final shapes, malformed mixed envelopes, and replay failures against the Python contract
- [x] 5.3 Correct stale runbook fixture hashes and document the independent wire/runtime version axes

## 6. Verify And Deliver The Consumer

- [x] 6.1 Run focused provisioner, reconciler, lifecycle-store, agent-contract, migration, and integration tests
- [x] 6.2 Run ESLint, TypeScript checking, operations-contract tests, and strict OpenSpec validation
- [x] 6.3 Obtain independent code/security review and exact-HEAD verification
- [x] 6.4 Commit, integrate current remote main, push, and open a ready PR with v2 issuance still disabled by default
- [ ] 6.5 Merge only after required checks pass and record exact forward and rollback commits

## 7. Expand And Contract With Exomem

- [ ] 7.1 Confirm exact D1, authoritative legacy-v1 catalog and set digest, expand/contract lock pair, and rehearsed D0 rollback evidence before enabling issuance
- [ ] 7.2 Under the cohort/admission lock freeze assignment/promotion changes, compare the current set digest, abort/regenerate on mismatch or cut traffic to D1 before release; prove every cataloged v1 unit plus synthetic v2, then enable v2 only for new operations
- [ ] 7.3 Use the authenticated content-free contraction readiness gate to prove stored retries remain stable, no fresh v1 work appears, unfinished v1 operations excluding succeeded/failed-terminal states are zero, and retained v1-origin exports (including download/GC continuations) are deleted before deploying the exact contract lock
- [ ] 7.4 Canary provision, complete runtime identity, binding, activation, and promotion under v2
- [ ] 7.5 Record live evidence and reject rollback while any v2 operation remains non-final, any cell/operation differs from the rollback unit, or the upgraded-schema rehearsal is absent
