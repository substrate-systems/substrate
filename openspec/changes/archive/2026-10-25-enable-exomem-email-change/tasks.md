## Release A: identity foundation

- [x] 1.1 Add and backfill Exomem identities without changing existing identifiers or shared-product records.
- [x] 1.2 Switch all Exomem identity reads and reviewer authorization to the separate authority.
- [x] 1.3 Keep legacy admission and deleted-account re-admission compatible through the temporary tenant bridge and safe shared-user fallback.
- [x] 1.4 Verify migrations, atomic role grants, existing sign-in, legacy and current deletion scrubbing, and cross-product isolation.
- [x] 1.5 Review and release the compatible foundation with the approved website batch.

## Release B: email changes

- [x] 2.1 Verify that deployments older than A cannot expose stale email authentication.
- [x] 2.2 Repoint the eight identity foreign keys and create new identities only within Exomem.
- [x] 2.3 Add request, confirmation and cancellation routes with atomic, expiring single-use state.
- [x] 2.4 Deliver the Home dialogs and the two fixed-recipient emails through the existing outbox.
- [x] 2.5 Preserve sessions and grants, invalidate old sign-in links, and scrub pending changes during deletion.
- [x] 2.6 Synchronize the existing provider customer with explicit pending, conflict and failed states.
- [x] 2.7 Verify race, replay, collision, provider failure and persistence behaviour in the isolated application.
- [x] 2.8 Complete independent review, browser acceptance, required CI, normal release and read-only production verification.
- [x] 2.9 Remove the temporary admission and deletion bridges after the rollback window closes.

Release A shipped in PR #264. Release B shipped in PR #265 on 2026-10-18 after the complete deployment fence check and execution drain.
Independent source review, isolated PostgreSQL probes, browser workflows and required CI support the checked tasks.
Read-only production checks confirmed the released source, production target, retained fence and public routes.

Native inbox behavior, received HTML, live provider permission and production-volume query plans remain unverified.
Migration 0078 removes the four bridges for task 2.9. PR #280 first moved the lapsed-tenant theme and identity scrub into the Cloud reconcile.

Task 2.9 shipped in PR #281 on 2026-10-25 after the seven-day rollback window.
Read-only production catalogue queries confirmed migration 0078, all four bridges absent, and 0077's cleanup retained.
Rollbacks must retain the lapse scrub introduced by PR #280.
