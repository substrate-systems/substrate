## 1. Read and store

- [x] 1.1 Read the cell's `whats_new` section in parallel with levels and activity; an older image or an unreachable cell yields no section.
  - Evidence: `cloud-home-postgres.integration.test.ts` (53 pass, 48 before) cases "shows the releases after the owner's dismissal…", "shows an owner with no dismissal only releases dated after the day the cell was created" and "shows no section, and no error, for an older image…"; selection rules in `cloud-home-whats-new.test.ts` (7 pass).
- [x] 1.2 Migration: the tenant's dismissed release version, nullable.
  - Evidence: `migrations/0095_exomem_whats_new_dismissed_version.sql` applies in the migration, grants and cells integration runs (73 pass); the substrate_app schema-wide grant covers the column, so `exomem-cloud-grants.sql` is unchanged.
- [x] 1.3 Owner-authenticated route that records a dismissal and keeps the higher version.
  - Evidence: `cloud-home-postgres.integration.test.ts` cases "records the version Home rendered, keeps the higher one against a stale tab, and touches only the owner's row" (includes four concurrent posts) and "refuses a dismissal that is not a release version or has no CSRF proof, and stores nothing". A text-comparison mutation of the update fails the first case on `'1.3.0' !== '1.10.0'`.

## 2. Home

- [x] 2.1 The What's new section and "Got it", inspected at desktop and phone widths in light and dark.
  - Evidence: `next dev` against a fresh migrated Postgres 16 and the e2e fake cell, rendered in Playwright Chromium at 1440 and 390 px in both colour schemes with two releases and three notes. The section matches the other Home cards and carries no explanatory text. Chrome DevTools was not available in the session; the inspection used Playwright screenshots.

- [x] 2.2 The redesign from the Claude Design commission (direction B, "In the status"): a line under the status opens a drawer of changes grouped by release day, with older days folded; inspected against the design boards at desktop and phone, light and dark.
  - Evidence: CI production builds of `main` and of the redesign, served by the Home end-to-end stand-ins with a disposable PostgreSQL 16, rendered in Playwright Chromium at 1440 and 390 px in both colour schemes, with 9 notes over two days and 31 notes over six days: one line under the status, the drawer by day, the fold and "Show", and both failed-dismissal lines. Design source: `docs/exomem-design/reference/boards/whats-new-b/`.

- [ ] 2.3 The revision from the same commission (board B2): one short title per change that opens its sentence, older days folded into a count; a note served without a title shows its sentence. Inspected against the B2 board at desktop and phone, light and dark.

## 3. Acceptance

- [ ] 3.1 On a real Cloud cell after a rollout that carries a note, Home shows the note; after "Got it" and a reload it does not.
