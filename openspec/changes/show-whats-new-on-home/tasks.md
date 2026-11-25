## 1. Read and store

- [x] 1.1 Read the cell's `whats_new` section in parallel with levels and activity; an older image or an unreachable cell yields no section.
  - Evidence: `cloud-home-postgres.integration.test.ts` (53 pass, 48 before) cases "shows the releases after the owner's dismissal…", "shows an owner with no dismissal only releases dated after the day the cell was created" and "shows no section, and no error, for an older image…"; selection rules in `cloud-home-whats-new.test.ts` (7 pass).
- [x] 1.2 Migration: the tenant's dismissed release version, nullable.
  - Evidence: `migrations/0095_exomem_whats_new_dismissed_version.sql` applies in the migration, grants and cells integration runs (73 pass); the substrate_app schema-wide grant covers the column, so `exomem-cloud-grants.sql` is unchanged.
- [x] 1.3 Owner-authenticated route that records a dismissal and keeps the higher version.
  - Evidence: `cloud-home-postgres.integration.test.ts` cases "records the version Home rendered, keeps the higher one against a stale tab, and touches only the owner's row" (includes four concurrent posts) and "refuses a dismissal that is not a release version or has no CSRF proof, and stores nothing". A text-comparison mutation of the update fails the first case on `'1.3.0' !== '1.10.0'`.

## 2. Home

- [ ] 2.1 The What's new section and "Got it", inspected in Chrome DevTools at desktop and phone widths in light and dark.

## 3. Acceptance

- [ ] 3.1 On a real Cloud cell after a rollout that carries a note, Home shows the note; after "Got it" and a reload it does not.
