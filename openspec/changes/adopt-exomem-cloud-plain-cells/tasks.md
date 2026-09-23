## 1. Specification (S)

- [ ] 1.1 Get an independent critic review of this change together with the Exomem companion, and resolve every blocking finding
- [ ] 1.2 Add a one-line superseded banner to the proposal of every change listed as superseded in design.md
- [ ] 1.3 Close the superseded Exomem-hosted PRs with a one-line reason, and keep their branches

## 2. Standard Postgres driver (lane D2, lands first)

- [ ] 2.1 Write red-first tests that run the `neon()` modules against a disposable standard Postgres through the new adapter, including `fullResults` shapes and the `transaction` commit and rollback paths
- [ ] 2.2 Implement the `pg`-backed `sql` adapter (D6), switch `exomem-hosted/db.ts`, `exomem-hosted/paddle-event-store.ts`, `hosted-backup/db.ts`, `hosted-backup/claim-tokens.ts` and `scripts/generate-jwt-keypair.ts`, and remove `@neondatabase/serverless`
- [ ] 2.3 Run the real-PostgreSQL matrix and the main suite, add the driver test to the CI integration list, and confirm behaviour against Neon is unchanged before cutover

## 3. Cloud control plane (lane C, after lane D2)

- [ ] 3.1 Add migration `0056_exomem_cloud_cells.sql` as the schema of record for:
  - C1 with every desired and observed column, the partial unique index on `tenant_id` for non-deleted rows, and the generation trigger with `pg_notify`;
  - C1b `exomem_cloud_settings`, C1c `exomem_cloud_capacity` and C1d `exomem_cloud_rollout` (one row, id 1).
  Test the trigger, the index and the constraint checks against real Postgres.
- [ ] 3.2 Add `scripts/exomem-cloud-grants.sql` and wire it into the migration runner after migrations, when the roles exist (D7). Run migrations through `DATABASE_MIGRATION_URL`. Test against real Postgres that:
  - the controller role can write only observed columns;
  - the gateway role can write only rate-limit buckets;
  - a second run changes nothing.
- [ ] 3.3 Write red-first admission tests against real Postgres covering:
  - the first invite on an empty fleet;
  - capacity exhausted with the invite unconsumed;
  - concurrent redemption at the last free slot;
  - a paid invite before checkout (`stopped`), activation (`running`) and the full-fleet refusal at activation;
  - the 7-day expiry of unpaid rows.
- [ ] 3.4 Implement Cloud admission (D1) under `EXOMEM_CLOUD_ENABLED`, without `exomem_capacity_pools`
- [ ] 3.5 Implement Cloud OAuth client admission and exact-resource token binding (D2). Test an empty cohort with an approved CIMD host, and cross-resource token refusal in both directions
- [ ] 3.6 Implement the gateway Cloud handler and protected-resource metadata (D3). Test against a real cell process for:
  - header allowlisting and principal-only routing;
  - no forwarding of `Authorization`;
  - streaming;
  - `GET` 405;
  - `CELL_NOT_READY` for a stopped cell and for an unreachable one;
  - `CELL_AUTH_MISMATCH` on a cell 401;
  - IP rate limits keyed on the ingress-recorded client address, and identity limits.
- [ ] 3.7 Map every effective entitlement to desired state per the D4 table, including `read_only` for grace, provider-paused and cancelled, and test each transition and its generation bump
- [ ] 3.8 Add the owner-only release route (D5): set `cell_image`, clear a paused rollout, set or clear a row's `desired_image`, and an operator view of observed cell state, rollout state and capacity. Test the non-owner refusal

## 4. Cutover and acceptance (P4)

- [ ] 4.1 Write the cutover runbook and script (D8): consumer inventory, Neon read-only freeze, `pg_dump --no-owner --no-acl`, restore as `substrate_owner`, grants script, per-table counts and checksums, `DATABASE_URL` and `DATABASE_MIGRATION_URL` switch with a production redeploy, and post-checks. Rehearse it against a disposable copy
- [ ] 4.2 After the Exomem control server is up, run the cutover in a maintenance window, and keep Neon read-only as the rollback
- [ ] 4.3 Enable `EXOMEM_CLOUD_ENABLED`, and run owner acceptance with the Exomem change's task 6.3

## 5. Retirement (R)

- [ ] 5.1 Delete the contract, candidate, cohort, promotion, reviewer and client-artifact code, the per-release fixtures and the v1 lifecycle for Cloud-superseded paths
- [ ] 5.2 Remove the superseded change directories and superseded `exomem-hosted-*` canonical requirements in the same delivery as their code
- [ ] 5.3 Delete the Neon database after 7 clean days on the new server
