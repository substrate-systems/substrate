## 1. Specification (S)

- [ ] 1.1 Get an independent critic review of this change together with the Exomem companion, and resolve every blocking finding
- [ ] 1.2 Add a one-line superseded banner to the proposal of every change listed as superseded in design.md
- [ ] 1.3 Close the superseded Exomem-hosted PRs with a one-line reason, and keep their branches

## 2. Standard Postgres driver (lane D2, lands first)

- [ ] 2.1 Write red-first tests that run the four `neon()` modules against a disposable standard Postgres through the new adapter, including `fullResults` shapes
- [ ] 2.2 Implement the `pg`-backed `sql` adapter (D6), switch `exomem-hosted/db.ts`, `exomem-hosted/paddle-event-store.ts`, `hosted-backup/db.ts` and `hosted-backup/claim-tokens.ts`, and remove `@neondatabase/serverless`
- [ ] 2.3 Run the real-PostgreSQL matrix and the main suite, and confirm behaviour against Neon is unchanged before cutover

## 3. Cloud control plane (lane C)

- [ ] 3.1 Add migration `0056_exomem_cloud_cells.sql` with:
  - the C1, C1b and C1c tables and the `pg_notify` trigger on generation changes;
  - role grants that apply only when each role exists.
  Test the grants.
- [ ] 3.2 Write red-first empty-fleet admission tests against real Postgres covering the first invite, capacity exhausted, and concurrent redemption at the last free slot
- [ ] 3.3 Implement Cloud admission (D1) under `EXOMEM_CLOUD_ENABLED`
- [ ] 3.4 Implement Cloud OAuth client admission and resource-bound token issuance (D2), and test an empty cohort with an approved CIMD host
- [ ] 3.5 Implement the gateway Cloud handler and protected-resource metadata (D3). Test against a real cell process for:
  - header allowlisting and principal-only routing;
  - no forwarding of `Authorization`;
  - streaming;
  - `CELL_NOT_READY`;
  - rate limits.
- [ ] 3.6 Map entitlement lapse and restore, and account deletion, to desired state (D4), and test each transition
- [ ] 3.7 Add the owner-only release and settings route and an operator view of observed cell state and capacity (D5)

## 4. Cutover and acceptance (P4)

- [ ] 4.1 After the Exomem control server is up, run the cutover runbook: dump, restore, per-table verification, switch `DATABASE_URL`, then Endstate and Exomem post-checks
- [ ] 4.2 Enable `EXOMEM_CLOUD_ENABLED`, and run owner acceptance with the Exomem change's task 6.3

## 5. Retirement (R)

- [ ] 5.1 Delete the contract, candidate, cohort, promotion, reviewer and client-artifact code, the per-release fixtures and the v1 lifecycle for Cloud-superseded paths
- [ ] 5.2 Remove the superseded change directories and superseded `exomem-hosted-*` canonical requirements in the same delivery as their code
