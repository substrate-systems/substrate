# Tasks

## 1. Notice record and operator route

- [x] 1.1 Add the migration for `exomem_service_notices`, `exomem_service_notice_cells` and the two outbox kinds; verify on isolated PostgreSQL that every registry kind stores.
- [x] 1.2 Add `service-notices.ts` and the admin route (create, list, cancel, resolve); verify operator auth, validation and terminal states.

## 2. Emails

- [x] 2.1 Add `maintenance_scheduled` and `incident_resolved` to the registry and templates; verify `stillHolds` drops cancelled and started maintenance.
- [x] 2.2 Add bounded fan-out to the delivery cron; verify covered owners only, one email per owner per notice across repeats, and a constant query count per batch.

## 3. Gateway notice

- [ ] 3.1 Add the cached current-notice lookup and the `x-exomem-service-notice` header; verify cell scoping, priority, encoding limits, the 30-second refresh and the forged-header refusal.

## 4. Operator command and runbook

- [ ] 4.1 Add `scripts/exomem-service-notice.ts` with the confirmation step and the status-page mirror; verify the issue body against the status renderer's metadata parser.
- [ ] 4.2 Add "Service notices" to `docs/runbooks/exomem-cloud-operations.md`: when to declare, copy rules, the command, and what each person sees.

## 5. Delivery

- [ ] 5.1 Rebase onto `main` after #320 merges and renumber the migration; pass scoped tests and the full suite.
- [ ] 5.2 Review the batch independently; resolve findings.
- [ ] 5.3 Merge and release; verify the admin route and an empty notice list in production without creating a notice.
