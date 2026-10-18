## Release A: identity foundation

- [x] 1.1 Add and backfill Exomem identities without changing existing identifiers or shared-product records.
- [x] 1.2 Switch all Exomem identity reads and reviewer authorization to the separate authority.
- [x] 1.3 Keep legacy admission and deleted-account re-admission compatible through the temporary tenant bridge and safe shared-user fallback.
- [x] 1.4 Verify migrations, atomic role grants, existing sign-in, legacy and current deletion scrubbing, and cross-product isolation.
- [x] 1.5 Review and release the compatible foundation with the approved website batch.

## Release B: email changes

- [ ] 2.1 Verify that deployments older than A cannot expose stale email authentication.
- [x] 2.2 Repoint the eight identity foreign keys and create new identities only within Exomem.
- [x] 2.3 Add request, confirmation and cancellation routes with atomic, expiring single-use state.
- [ ] 2.4 Deliver the Home dialogs and the two fixed-recipient emails through the existing outbox.
- [x] 2.5 Preserve sessions and grants, invalidate old sign-in links, and scrub pending changes during deletion.
- [x] 2.6 Synchronize the existing provider customer with explicit pending, conflict and failed states.
- [ ] 2.7 Verify race, replay, collision, provider failure and persistence behaviour in the isolated application.
- [ ] 2.8 Complete independent review, browser acceptance, required CI, normal release and read-only production verification.
- [ ] 2.9 Remove the temporary admission and deletion bridges after the rollback window closes.

Implementation checks use isolated data. Release, deployment protection and browser acceptance remain in the unchecked tasks.
