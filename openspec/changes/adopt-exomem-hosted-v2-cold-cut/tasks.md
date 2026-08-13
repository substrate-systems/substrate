## 1. Freeze The Post-Fix Release Evidence

- [ ] 1.1 Add red-first release-verification tests that refuse an unsigned-or-unverifiable release when upstream declares a signature, distinguish signature verification from SHA-256 integrity verification, and refuse every incomplete or non-deterministic tuple.
- [ ] 1.2 Implement four separately complete post-release records: runtime (source/image/private gateway/agent runtime/command), provisioner (source/image/outer wire/runtime identity), composition (Git/forward artifact/lock-pair bytes/schema version/deployed manifest), and clients (Claude/OpenAI package/archive/plugin/registered-app/configuration). The payload contains the raw compatibility artifact SHA-256 plus four separate raw lock-file SHA-256s (Claude package/archive and OpenAI package/archive). Pin none until the post-release gate passes.
- [ ] 1.3 Add regression tests that preserve the rejected 0.48.0 baseline as non-active reference, require separate digest domains, and reject the forbidden `18325eebae09e2e974af3837ca120ddbe829a05e05a67454623613b7f49c09c0` value.
- [ ] 1.4 Derive a deterministic release-independent Substrate gateway schema projection only after exact runtime self-digest verification; add mismatch and nondeterminism tests.

## 2. Fence And Empty The Old Cohort

- [ ] 2.1 Add red-first external-fence tests: edge/WAF denies `/api/exomem/**`; `EXOMEM_HOSTED_COLD_CUT_MAINTENANCE=true` independently denies mutations; scheduler ingress is disabled; and old Vercel deployment URLs are protected or old database/provisioner/Cloudflare Access credentials are rotated.
- [ ] 2.2 Implement the exclusive maintenance-window control and per-mutation advisory transaction lock; prove the latter cannot be treated as a global fence, stop/drain every old replica, and fail closed if any old process remains reachable.
- [ ] 2.3 Add real-Postgres repeatable-read snapshot tests for exact current-state zero predicates: non-final operations, non-deleted cells/exports, current assignments/transfers/reviewer authority, and enabled or otherwise reachable v1 OAuth/client lineage, while terminal/revoked/expired/consumed history remains allowed.
- [ ] 2.4 Implement the content-free operator audit result and early configuration snapshot. Only after external fences/drain and successful audit, create the database restore point and bind its LSN/timestamp to the audit snapshot before `0046` or v2 mutation; do not add implicit cleanup or incident recovery.

## 3. Replace The Legacy Singleton With One V2 Cohort

- [ ] 3.1 Add failing migration tests proving `0031`/`0032` remain immutable and new `0046` replaces the latest `0034` cohort view identically except for the verified v2 profile predicate; prove it adds no lifecycle profile column, v1 backfill/default, dual-live state, or control-plane/provider side effect.
- [ ] 3.2 Add the narrow cold-cut `0046` migration replacing only the latest `0034` hard-coded v1 cohort-view predicate with the verified v2 predicate.
- [ ] 3.3 Convert process-global catalog, private route mapping, fixtures, and factories to v2-only; remove rolling selection and cross-profile descendant behavior rather than preserving compatibility branches.
- [ ] 3.4 Add gateway/MCP tests proving authoritative v2 mapping, rejection of caller-selected profile/routes and old private mappings, and preservation of the published public MCP URL.
- [ ] 3.5 Require outer `exomem-cell-provisioner.v2` issuance on every new process and add deployment/configuration tests that absent, false, malformed, or old-catalog process state fails admission.

## 4. Establish Fresh V2 Authority And Reopen

- [ ] 4.1 Add red-first client/OAuth/reviewer tests proving bootstrap, staged clients, transactions, grants, token families, and install actions are newly created from the active v2 tuple and cannot reuse old lineage.
- [ ] 4.2 Implement one bounded protected operator-control maintenance capability, created only for the verified tuple, that under the per-mutation advisory transaction lock permits only exact pending import → fresh Claude/OpenAI stage → fresh reviewer bootstrap; revalidate the full tuple each step, consume on completion, and remove/revoke on abort.
- [ ] 4.3 Implement the exact one-window reviewer-canary exception: one fresh bootstrap authority, staged client, OAuth transaction/lineage, canonical resource, and newly minted MCP bearer; reject all general OAuth, refresh, old bearer, route selector, and public-write traffic during maintenance.
- [ ] 4.4 Implement fresh reviewer bootstrap, staged client artifacts, promotion evidence, and artifact verification records with exact signature-versus-digest terminology.
- [ ] 4.5 Add the authenticated clean-client smoke and enforce exact order: verify raw artifact payload, import, stage both clients, bootstrap, OAuth/MCP smoke/evidence, one-transaction candidate then paired-artifact promotion/retirement, remove exception; require completion before the public-write fence can be released.
- [ ] 4.6 Update the Hosted runbook with external maintenance fence, edge/Vercel/credential contingencies, exact predicates, v2-only startup, maintenance capability, fresh-authority exception, smoke, reopen, and abort procedures.

## 5. Prove Rollback Boundaries And Deliver

- [ ] 5.1 Capture immutable early configuration/deployment/credential/old-0.39 evidence, then only after fences/drain/zero audit capture the database restore point; bind its LSN/time to the audit and require both records for every rollback branch.
- [ ] 5.2 Add tests for pre-first-v2-work restoration of the previously verified 0.39 stack.
- [ ] 5.3 Add tests that post-v2-work rollback accepts only a pair-bound, proven-compatible v1 rollback runtime and newly proven client cohort; reject an unproven old 0.39 rollback claim.
- [ ] 5.4 Add tests requiring an explicit operator-approved destructive restore plan and confirmed loss boundary when the post-v2 pair-bound rollback proof is absent.
- [ ] 5.5 Run focused release/catalog, real-Postgres fence/audit/migration, gateway/MCP, OAuth/client/reviewer, scheduler, provisioner, and smoke suites with fresh output.
- [ ] 5.6 Run TypeScript checking, lint, format, production build, strict OpenSpec validation, and independent security/architecture plus end-to-end verification before any live window.
