## 1. Specification (S)

- [x] 1.1 Get an independent critic review of this change together with the Exomem companion, and resolve every blocking finding
- [x] 1.2 Add a one-line superseded banner to the proposal of every change listed as superseded in design.md
- [x] 1.3 Close the superseded Exomem-hosted PRs with a one-line reason, and keep their branches

## 2. Standard Postgres driver (lane D2, lands first)

- [x] 2.1 Write red-first tests that run the `neon()` modules against a disposable standard Postgres through the new adapter, including `fullResults` shapes and the `transaction` commit and rollback paths
- [x] 2.2 Implement the `pg`-backed `sql` adapter (D6), switch `exomem-hosted/db.ts`, `exomem-hosted/paddle-event-store.ts`, `hosted-backup/db.ts`, `hosted-backup/claim-tokens.ts` and `scripts/generate-jwt-keypair.ts`, and remove `@neondatabase/serverless`
- [x] 2.3 Run the real-PostgreSQL matrix and the main suite, add the driver test to the CI integration list, and confirm behaviour against Neon is unchanged before cutover

## 3. Cloud control plane (lane C, after lane D2)

- [x] 3.1 Add migration `0056_exomem_cloud_cells.sql` as the schema of record for:
  - C1 with every desired and observed column, the partial unique index on `tenant_id` for non-deleted rows, and the generation trigger with `pg_notify`;
  - C1b `exomem_cloud_settings`, C1c `exomem_cloud_capacity` and C1d `exomem_cloud_rollout` (one row, id 1).
  Test the trigger, the index and the constraint checks against real Postgres.
- [x] 3.2 Add `scripts/exomem-cloud-grants.sql` and wire it into the migration runner after migrations, when the roles exist (D7). The script grants `substrate_app` DML on every `public` table and sequence, with default privileges for later migrations, and implements exactly the C1 privilege table in the Exomem design for C1 through C1d. Run migrations through `DATABASE_MIGRATION_URL` on PgBouncer's session-mode alias. Test against real Postgres that:
  - the controller role can write only C1 observed columns, C1c, and the C1d fields it owns, and cannot write desired columns or C1b;
  - the gateway role can read only C1 routing columns and write only rate-limit buckets;
  - as `substrate_app`, every `public` table except C1 through C1d accepts SELECT, INSERT, UPDATE and DELETE, every sequence is usable, and a table created by a later migration inherits the same grants;
  - a second run changes nothing.
- [x] 3.3 Write red-first admission tests against real Postgres covering:
  - the first invite on an empty fleet;
  - capacity exhausted with the invite unconsumed;
  - concurrent redemption at the last free slot;
  - a paid invite before checkout (`stopped`), and activation to `running` with no second capacity check, even on a full fleet;
  - the 7-day expiry: the pending provider transaction is cancelled and the row deleted, or, when the provider reports it completed, the row is left for activation.
- [x] 3.4 Implement Cloud admission (D1) under `EXOMEM_CLOUD_ENABLED`, without `exomem_capacity_pools`
  - fix the paid-activation webhook's `requires_provision_release` guard throwing `division by zero` for a Cloud tenant (it has no v1 capacity allocation to release), tested through the real Paddle event store
- [x] 3.5 Implement Cloud OAuth client admission and exact-resource token binding (D2). Test an empty cohort with an approved CIMD host, and cross-resource token refusal in both directions
- [x] 3.6 Implement the gateway Cloud handler and protected-resource metadata (D3). Test against a real cell process for:
  - header allowlisting and principal-only routing;
  - no forwarding of `Authorization`;
  - streaming;
  - `GET` 405;
  - `CELL_NOT_READY` for a stopped cell and for an unreachable one;
  - `CELL_AUTH_MISMATCH` on a cell 401;
  - IP rate limits keyed on the ingress-recorded client address, and identity limits.
- [x] 3.7 Map every effective entitlement to desired state per the D4 table, including `read_only` for grace and provider-paused, and the cancelled export window followed by `deleted`. Test each transition and its generation bump, and resubscription within the window. State the window on the terms page and in the cancellation email
- [x] 3.8 Add the owner-only release route (D5): set `cell_image`, clear a paused rollout, set or clear a row's `desired_image`, and an operator view of observed cell state, rollout state and capacity. Test the non-owner refusal
- [x] 3.9 Close the review follow-ups before friends are invited, each tested against real Postgres where it touches the database:
  - re-admission only for a `deleted` or pre-payment tenant, resetting every provider field (D1);
  - the reviewer route's provider-review branch refused under Cloud, and every cell deletion (expiry, reconcile, account deletion) revoking the tenant's Cloud grants, token families and access tokens in the same transaction (D2);
  - account deletion reaching the Cloud cell row (deleted, consent revoked) at confirmation and on the sweep;
  - the gateway's IP-bucket skip counted and logged (D3);
  - a failed or thrown cancellation notice releasing its claim, and the sweep retrying it (D4);
  - the release PUT validating everything before one transactional write (D5);
  - `schema_migrations` excluded from `substrate_app`'s schema-wide grant (D7)
- [x] 3.10 Finish Cloud account deletion without the v1 lifecycle (D4 "Cloud deletion finish"), before friends are invited:
  - no v1 delete operation for a tenant that owns a Cloud cell row, deleted rows included;
  - the finish selecting `deletion_pending` tenants that own any Cloud cell row, so a cell deleted before confirmation (expired unpaid invite) is still finished;
  - billing cancelled through billing deletion, then the tenant scrubbed in one transaction, retried by the sweep;
  - tested against real Postgres from confirmation to a `deleted` tenant, for both a live cell and one already deleted, leaving exactly the D4 receipt.

## 4. Cutover and acceptance (P4)

- [ ] 4.1 Write the cutover runbook and script (D8): consumer inventory, Neon lockout (`NOLOGIN` and password rotation for every application role, session termination, then the read-only default), `pg_dump --no-owner --no-acl` as a separate dump role, restore as `substrate_owner`, grants script, per-table counts and checksums, `DATABASE_URL` and `DATABASE_MIGRATION_URL` switch with a production redeploy, and post-checks. Rehearse it against a disposable copy
- [ ] 4.2 After the Exomem control server is up, run the cutover in a maintenance window, and keep Neon read-only as the rollback
- [ ] 4.3 Enable `EXOMEM_CLOUD_ENABLED`, and run owner acceptance with the Exomem change's task 6.3

## 5. Retirement (R)

- [ ] 5.1 Delete the contract, candidate, cohort, promotion, reviewer and client-artifact code, the per-release fixtures and the v1 lifecycle for Cloud-superseded paths
- [ ] 5.2 Remove the superseded change directories and superseded `exomem-hosted-*` canonical requirements in the same delivery as their code
- [ ] 5.3 Delete the Neon database after 7 clean days on the new server
