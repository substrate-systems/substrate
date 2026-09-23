## Context

The companion Exomem change `adopt-exomem-cloud-plain-cells` owns the architecture. This change owns the Substrate half. The measured problem and the retired controls, each with what it prevented, its wrong-firing cost and who paid, are recorded there and not repeated here.

Two facts were verified against this repository on 2026-09-23:

- `neon()` from `@neondatabase/serverless` is used in `exomem-hosted/db.ts`, `exomem-hosted/paddle-event-store.ts`, `hosted-backup/db.ts` and `hosted-backup/claim-tokens.ts`. That driver cannot reach standard Postgres, while `pg` over TCP already runs on Vercel for transactions (`db.ts`).
- Exomem tables reference the shared `users` table, so the whole database moves as one unit.

## Goals / Non-Goals

**Goals:** first-user admission on an empty fleet; one pass-through MCP hop next to the cells; lifecycle as data; the application portable to standard Postgres.

**Non-Goals:**

- generic DCR clients (`admit-generic-mcp-clients` remains future work);
- public self-serve;
- marketplace listing;
- new billing semantics;
- moving the website off Vercel.

## Decisions

### D1. Admission creates intent, not a provisioning operation

`redeemInviteAtomic` keeps its invite, account-block, tenant-dedupe and entitlement checks. For Cloud it replaces the `live_target` snapshot and the cohort advisory lock with a capacity check:

- The count of non-deleted `exomem_cloud_cells` rows must be below the sum of `cell_slots` over `exomem_cloud_capacity`.
- The check runs under a transaction-scoped advisory lock on `exomem-cloud-capacity`, before any write-bearing CTE.
- When capacity is exhausted, it returns the existing typed `HOSTED_ADMISSION_CLOSED` 503 and leaves the invite unconsumed.

The `exomem_capacity_pools` reservation is not used for Cloud.

**On success** it inserts the tenant, the entitlement and one cells row. That row's desired state follows the D4 mapping:

- A complimentary invite starts `running`.
- A paid invite whose tenant is `awaiting_checkout` starts `stopped`. cellctl creates nothing for a row that has never run.
- The row becomes `running` when checkout activates the entitlement.
- A row still `awaiting_checkout` after 7 days is set to `deleted`, so an unpaid invite cannot hold capacity indefinitely.
- Capacity is checked again at activation. A full fleet at that moment returns the typed refusal before the provider charge is accepted.

The OAuth invite path follows the same order.

### D2. OAuth client admission for Cloud

`resolveApprovedOAuthClient` admits a client for the Cloud resource when all of these hold:

- the client is enabled;
- its redirect digest matches;
- its CIMD metadata host is in `exomem_oauth_admitted_cimd_hosts`, with fresh metadata.

The whole-cohort `EXISTS` and the reviewer-credential branch do not apply to the Cloud resource.

The Cloud MCP resource is a distinct configured URL, `EXOMEM_CLOUD_MCP_URL`. Tokens are bound to it by **exact resource equality**, as hosted tokens already are. A hosted-resource token is never accepted on the Cloud path, and a Cloud-resource token is never accepted on the hosted path. Cloud-resource tokens are issued only when the principal owns a non-deleted cell row.

### D3. The gateway is a pass-through

`src/exomem-gateway/server.ts` gains a Cloud handler for `EXOMEM_CLOUD_MCP_PATH` and serves the protected-resource metadata for that resource. For each request it:

1. Answers `GET` with 405, as hosted does.
2. Rejects forbidden selector headers.
3. Applies the IP rate limit, keyed on the client address our own Traefik ingress records. The header is trusted only on connections arriving from Traefik.
4. Parses the bearer, looks up the access token for the Cloud resource, and applies identity rate limits and concurrency guards. Rate-limit buckets are the existing upserted table, so the gateway role can write them.
5. Resolves the principal's tenant and cell row. It proxies only while `desired_state` is `running` or `read_only`, and answers 503 `CELL_NOT_READY` otherwise. It gates on desired state, not on the eventually consistent `ready` column.
6. Derives the cell bearer from `EXOMEM_CLOUD_CELL_TOKEN_KEY` (contract C4).
7. Streams to the cell per contract C3:
   - it forwards only `content-type`, `accept`, `mcp-session-id` and `mcp-protocol-version`, and adds `x-request-id`;
   - an upstream connect failure maps to 503 `CELL_NOT_READY`;
   - a cell 401 maps to 502 `CELL_AUTH_MISMATCH`.

Responses are `private, no-store`. Telemetry stays content-free. The gateway image keeps the existing main-only publish workflow, and the Exomem platform chart consumes it by digest.

### D4. Lifecycle is desired state

Every lifecycle transition is an `UPDATE` of `desired_state`. The C1 trigger bumps `generation` and notifies cellctl. The mapping from the effective entitlement (`entitlements.ts`) keeps today's read, write and export semantics:

| Effective entitlement | read / write | `desired_state` |
|---|---|---|
| `active`, `trialing`, complimentary active | allow / allow | `running` |
| `grace` (`past_due`), provider `paused`, `cancelled` | allow / deny | `read_only` |
| `suspended` (manual), complimentary revoked | deny / deny | `stopped` |
| Tenant `awaiting_checkout` (no entitlement yet) | no cell | `stopped`, then `deleted` after 7 days |
| Account deletion | — | `deleted`; only a content-free receipt remains once cellctl reports `deleted` |

Export for read-only tenants uses the operator export runbook until a self-serve export exists. Cloud cells get no lifecycle operation, reconciler claim, fence or provisioner call. The existing v1 queue stays dormant for legacy rows until retirement.

### D5. The release is one setting

An owner-only admin route sets `exomem_cloud_settings.cell_image`. The same route can:

- clear a paused `exomem_cloud_rollout`;
- set or clear a single row's `desired_image`;
- show the rollout state, capacity and each cell's observed state.

There are no candidate imports, promotion or fixtures.

### D6. The driver runs on standard Postgres

A single module, `src/lib/db/pg-sql.ts`, exports `sql`: a tagged template and `query(text, params)` with the call shape the modules use today, including the `fullResults` shape, plus an atomic `transaction((tx) => [...])` that runs its statements in one `BEGIN`/`COMMIT` on one connection. Endstate account recovery uses `transaction` (`recoverFinalizeAtomic` in `src/lib/hosted-backup/db.ts`).

- It is backed by one lazily created `pg.Pool` per process against `DATABASE_URL`.
- TLS follows the connection string.
- The pool is small, suited to serverless instances behind a transaction-mode PgBouncer.
- No named prepared statement outlives a transaction.

The four modules and `scripts/generate-jwt-keypair.ts` switch to it, and `@neondatabase/serverless` is removed. Behaviour against Neon stays identical until cutover, so this lands first.

### D7. Database roles and grants

- **Migrations** run as `substrate_owner`, through `DATABASE_MIGRATION_URL` in the build-time migration step.
- **The application** runs as `substrate_app`, which is not the schema owner.
- **Grants** live in `scripts/exomem-cloud-grants.sql` and are idempotent. The migration runner applies them after migrations whenever the roles exist, and the cutover applies them after restore. They are not buried in a migration that ran on a database where the roles did not yet exist.
- **Gateway:** `exomem_gateway` receives `SELECT` on the token, tenant, entitlement and cell routing columns, plus `INSERT`/`UPDATE` on `exomem_rate_limit_buckets`.
- **cellctl:** `exomem_cellctl` receives exactly the column privileges in the Exomem design (D12).

### D8. Cutover from Neon

A single runbook and script. They preserve every write, carry Endstate unchanged, and keep Neon as the rollback.

1. **List every consumer** of the Neon database first:
   - Vercel production;
   - the old platform's in-cluster gateway and provisioner, both scaled to zero before the window;
   - node CronJobs;
   - operator scripts.
2. **Freeze Neon:** open the maintenance window by setting Neon to `default_transaction_read_only = on` and terminating existing sessions. A late write then fails instead of being lost.
3. **Copy:** `pg_dump --no-owner --no-acl`, then restore as `substrate_owner`.
4. **Grant:** run the grants script.
5. **Verify** extensions and sequence values, and compare per-table row counts and checksums.
6. **Switch:** set the Vercel `DATABASE_URL` and `DATABASE_MIGRATION_URL`, then redeploy production so the new environment takes effect.
7. **Post-check:** an Exomem admission dry run, an Endstate backup read, and a Paddle webhook replay against the new database.
8. **Retain** Neon, read-only, as the rollback until retirement.

## Shared contracts with Exomem

Contracts C1 (`exomem_cloud_cells`), C1b (`exomem_cloud_settings`), C1c (`exomem_cloud_capacity`), C1d (`exomem_cloud_rollout`), C3 (gateway to cell) and C4 (cell bearer derivation) are defined in the Exomem design. `migrations/0056_exomem_cloud_cells.sql` is the schema of record for C1 through C1d. The Exomem fixture copies it, and the local rehearsal runs this migration itself.

## Disposition of existing changes

**Superseded for Cloud; not to be implemented further. Removed with their code in retirement:**

- `simplify-hosted-launch-boundaries`
- `adopt-exomem-hosted-v2-cold-cut`
- `bind-exomem-provisioner-v2-runtime-identity`
- `add-hosted-cell-rollforward`
- `scope-cohort-admission-per-platform`
- `unblock-fresh-hosted-cohort`
- `upgrade-exomem-hosted-0-63-1`
- `decouple-reviewer-assignment-expiry`
- `recover-expired-bound-reviewer-cleanup`
- `recover-expired-reviewer-cleanup`
- `recover-terminal-reviewer-delete`
- `bootstrap-exomem-reviewer-oauth`
- `add-exomem-marketplace-reviewer-access`

The remaining tasks of `add-exomem-hosted-mcp-oauth` and `admit-cimd-clients-by-host` are superseded too. Their shipped OAuth authorization server and host allowlist are kept.

**Retained:**

- `admit-generic-mcp-clients`
- `defer-exomem-hosted-self-serve`
- `enable-exomem-paid-alpha-invites`
- `reclaim-oauth-client-slots`
- `productize-exomem-hosted-marketplace` (its public privacy and terms pages)
- every Endstate and website change

## Risks / Trade-offs

- **Serverless connection fan-out.** Mitigated by PgBouncer in transaction mode and a small per-instance pool. The gateway, which is on the hot path, holds a normal long-lived pool on the private network.
- **A paid invite reserves a row, not a volume,** until checkout activates it. Stale unpaid rows expire after 7 days.
- **The capacity check under an advisory lock serializes admissions.** That is negligible at alpha volume.
- **Cutover correctness for Endstate.** The same `pg_dump`/restore carries Endstate tables. The cutover runbook verifies row counts and checksums, and exercises one Endstate backup read before re-enabling traffic.

## Migration Plan

1. The driver swap (D6, delivered by lane D2) is delivered and deployed against Neon with no behaviour change.
2. The migration, admission, client admission, gateway handler, lifecycle intent, settings and the operator view are delivered behind `EXOMEM_CLOUD_ENABLED`.
3. The local rehearsal runs.
4. The database cutover, the gateway deployment to the cluster, and enabling Cloud all happen at P4.
5. Rollback before enabling is to leave the flag off. After cutover, restore from the retained Neon export.
