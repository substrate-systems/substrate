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
- The `stopped` row holds its capacity slot from redemption, because capacity counts rows. Activation therefore needs no second capacity check, and a completed payment always has a slot.
- The row becomes `running` when checkout activates the entitlement.
- **Expiry.** A tenant still `awaiting_checkout` after 7 days is expired, so an unpaid invite cannot hold capacity indefinitely:
  1. Expiry first cancels the tenant's pending provider transaction.
  2. If the provider reports the transaction already completed, expiry does nothing and the activation webhook proceeds as usual.
  3. Otherwise the row is set to `deleted`.
  No payment can complete without a cell. While a tenant has no non-deleted cell row, checkout is refused. A new invite re-admits that tenant under the same capacity check and creates a new row.
- **Re-admission scope.** Re-admission applies only to a tenant whose status is `deleted`, or to a pre-payment tenant (`awaiting_checkout` or `checkout_pending`) with no live provider subscription. It resets every provider field, including `provider_environment`. A tenant that is `deletion_pending`, or has a live subscription, is never re-admitted: the invite is refused and left unconsumed.
- **Pre-payment rows belong to D1, not D4.** The periodic D4 sweep skips a row whose tenant is still `awaiting_checkout` or `checkout_pending`. An entitlement state the mapping does not recognise yields `stopped`, never a state that allows reads.
- **Activation is D4's job.** A completed checkout makes the entitlement active, and the D4 reconcile then moves the row to `running`. There is no separate activation call.

The OAuth invite path follows the same order.

### D2. OAuth client admission for Cloud

`resolveApprovedOAuthClient` admits a client for the Cloud resource when all of these hold:

- the client is enabled;
- its redirect digest matches;
- its CIMD metadata host is in `exomem_oauth_admitted_cimd_hosts`, with fresh metadata.

The whole-cohort `EXISTS` and the reviewer-credential branch do not apply to the Cloud resource. While `EXOMEM_CLOUD_ENABLED` is on, the reviewer route's provider-review branch is refused.

**Deletion revokes consent.** The transaction that sets a cell row to `deleted`, whether through expiry, reconcile or account deletion, also revokes the tenant's OAuth grants, refresh-token families and access tokens. It revokes every grant the tenant holds, which under Cloud is only the Cloud resource, so a deletion never depends on Cloud configuration being present. A re-admitted tenant's new cell is then reachable only after fresh consent.

The Cloud MCP resource is a distinct configured URL, `EXOMEM_CLOUD_MCP_URL`. Tokens are bound to it by **exact resource equality**, as hosted tokens already are. A hosted-resource token is never accepted on the Cloud path, and a Cloud-resource token is never accepted on the hosted path. Cloud-resource tokens are issued, at code exchange and at refresh, only when the principal owns a non-deleted cell row.

**Scopes.** A cell sees one fixed non-owner principal and cannot enforce a read-only grant. A Cloud-resource grant therefore always carries both `exomem.read` and `exomem.write`:
- An authorization request for the Cloud resource that omits `scope` receives both.
- A request naming only a subset is refused with `invalid_scope`, whose description says Exomem Cloud needs both.
- The gateway refuses a token lacking either scope with 403 `INSUFFICIENT_SCOPE`.
Per-token read-only access is deferred. It would need a C3 request flag that the cell enforces.

### D3. The gateway is a pass-through

`src/exomem-gateway/server.ts` gains a Cloud handler for `EXOMEM_CLOUD_MCP_PATH` and serves the protected-resource metadata for that resource. For each request it:

1. Answers `GET` with 405, as hosted does.
2. Rejects forbidden selector headers.
3. Applies the IP rate limit, keyed on `X-Real-Ip`. Our own Traefik overwrites that header, and a NetworkPolicy admits only Traefik to the gateway (Exomem D11). If the request carries no client address, the IP bucket is skipped, and the gateway counts and logs that skip (content-free) so a misconfigured ingress that blanks the header is visible. It is never collapsed into one shared bucket, because a single sender could then rate-limit every user. The identity limit and the in-flight cap still apply.
4. Parses the bearer, looks up the access token for the Cloud resource, requires both scopes (D2), and applies identity rate limits and concurrency guards. A per-identity concurrency slot is held until the relayed response body ends, errors or is cancelled, not merely until headers arrive. Rate-limit buckets are the existing upserted table, so the gateway role can write them.
5. Resolves the principal's tenant and cell row. It proxies only while `desired_state` is `running` or `read_only`, and answers 503 `CELL_NOT_READY` otherwise. It gates on desired state, not on the eventually consistent `ready` column.
6. Derives the cell bearer from `EXOMEM_CLOUD_CELL_TOKEN_KEY` (contract C4).
7. Streams to the cell per contract C3:
   - it forwards only `content-type`, `accept`, `mcp-session-id` and `mcp-protocol-version`, and adds `x-request-id`;
   - an upstream connect failure maps to 503 `CELL_NOT_READY`;
   - a cell 401 maps to 502 `CELL_AUTH_MISMATCH`;
   - it sends `accept-encoding: identity` upstream, and relays only the response headers `content-type`, `mcp-session-id` and `mcp-protocol-version`, setting its own `cache-control`. The cell's `cell_id` is validated against the C1 format before it is used in a URL or HMAC.

Responses are `private, no-store`. Telemetry stays content-free. The gateway image keeps the existing main-only publish workflow, and the Exomem platform chart consumes it by digest.

### D4. Lifecycle is desired state

Every lifecycle transition is an `UPDATE` of `desired_state`. The C1 trigger bumps `generation` and notifies cellctl. The mapping from the effective entitlement (`entitlements.ts`) keeps today's read, write and export semantics:

| Effective entitlement | read / write | `desired_state` |
|---|---|---|
| `active`, `trialing`, complimentary active | allow / allow | `running` |
| `grace` (`past_due`), provider `paused` | allow / deny | `read_only` |
| `cancelled` | allow / deny | `read_only` for a fixed 30-day export window from the cancellation's `source_occurred_at`, then `deleted` |
| `suspended` (manual), complimentary revoked | deny / deny | `stopped` |
| Tenant `awaiting_checkout` (no entitlement yet) | no cell | `stopped`, then `deleted` after 7 days |
| Account deletion | — | `deleted`, at confirmation and on every sweep, even before payment. The tenant row stays `deletion_pending` until the Cloud deletion finish (below) has cancelled billing and scrubbed it. Once cellctl reports `deleted`, only the receipt defined below remains |

**Cloud deletion finish.** A Cloud tenant's account deletion never goes through the v1 lifecycle: no v1 delete operation is created for a tenant that owns a Cloud cell row, including one already `deleted` (an unpaid invite that expired before the owner confirmed deletion). The Cloud step selects by tenant, every `deletion_pending` tenant owning any Cloud cell row, so a cell deleted before confirmation is still finished. Once its cell row is `deleted`, the step cancels the provider subscription through billing deletion, then scrubs the tenant in one transaction, as the v1 finish did: status `deleted` with `deleted_at`, entitlement provider references cleared, and invites, sessions, access tokens and transfer grants purged. Billing is terminated before the scrub, because the scrub clears the references the cancellation needs. The periodic sweep retries both until they succeed. Neither step depends on the v1 provisioner or its lane. The receipt that remains is exactly: the tenant row (`deleted`, `deleted_at`), its entitlement without provider references, the `deleted` cell row, and the revoked OAuth grant, family and token rows. The `users` row is the shared Substrate account, which other products' rows reference, so an Exomem account deletion leaves it and its email in place; erasing the Substrate account itself is a separate, account-wide deletion.

Export for read-only tenants uses the operator export runbook (Exomem D8) until a self-serve export exists. The cancelled-tenant export window is a constant, not a setting, so the terms page, the email and the deletion always agree. The terms page states it. The cancellation email names its end date, computed exactly as the deletion is. The email is sent at most once per cancellation, and only while the cell is still cancelled and `read_only`, which the claim itself re-checks: a failed or thrown send releases its claim and is logged, the periodic D4 sweep retries the notice for any cancelled `read_only` row whose claim is null and whose export window is still open, and a return to `running` clears the claim so a later cancellation is noticed again. Resubscribing within the window returns the row to `running`. Cloud cells get no lifecycle operation, reconciler claim, fence or provisioner call. The existing v1 queue stays dormant for legacy rows until retirement.

### D5. The release is one setting

An owner-only admin route sets `exomem_cloud_settings.cell_image`. Every image it accepts, for the setting or for a row, must be exactly `<configured cell repository>@sha256:<64 lowercase hex>`. Anything else is refused as an invalid request. A request that changes several values validates all of them before writing any, and writes them in one transaction, so a partly invalid request changes nothing. The same route can:

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

- **Migrations** run as `substrate_owner`, through `DATABASE_MIGRATION_URL` in the build-time migration step. That URL names PgBouncer's session-mode alias, because `scripts/migrate.ts` holds a session-level advisory lock that transaction pooling would leak.
- **The application** runs as `substrate_app`, which is not the schema owner.
- **Grants** live in `scripts/exomem-cloud-grants.sql` and are idempotent. The migration runner applies them after migrations whenever the roles exist, and the cutover applies them after restore. They are not buried in a migration that ran on a database where the roles did not yet exist.
- **Application:** `substrate_app` receives `SELECT`, `INSERT`, `UPDATE` and `DELETE` on every table in the `public` schema except `schema_migrations`, and `USAGE` and `SELECT` on every sequence. `schema_migrations` belongs to the migration runner. No runtime code reads it, so `substrate_app` holds nothing on it. The script resolves its schema with `current_schema()`: `public` on the migration connection, and each integration test's own schema, which every harness relies on. `ALTER DEFAULT PRIVILEGES FOR ROLE substrate_owner` extends the same grants to tables and sequences created by later migrations. The cutover restores with `--no-acl`, so without these grants the website, OAuth, Paddle and Endstate would all lose access to their tables. The only exceptions are C1 through C1d.
- **Gateway:** `exomem_gateway` receives `SELECT` on the token, tenant and entitlement columns it reads, plus `INSERT`/`UPDATE` on `exomem_rate_limit_buckets`.
- **Cloud tables:** every role's privileges on C1 through C1d are exactly the C1 privilege table in the Exomem design. The script revokes `substrate_app`'s schema-wide grants on those four tables and then applies the exact table. That makes the script the single implementation of the C1 table, and a rerun converges to the same state.
- **Proof as the real roles.** Tests that connect as a superuser cannot see a missing grant. A real-Postgres test applies every migration and the script, then checks as `substrate_app` that every `public` table except C1 through C1d accepts all four operations, that every sequence is usable, and that C1 through C1d match the C1 table exactly. The local rehearsal runs Substrate as `substrate_app` and the gateway and cellctl as their own roles.

### D8. Cutover from Neon

A single runbook and script. They preserve every write, carry Endstate unchanged, and keep Neon as the rollback.

1. **List every consumer** of the Neon database first:
   - Vercel production;
   - the old platform's in-cluster gateway and provisioner, both scaled to zero before the window;
   - node CronJobs;
   - operator scripts.
2. **Freeze Neon.** Open the maintenance window by locking out every application role, so no client can write:
   - `ALTER ROLE … NOLOGIN` and rotate the password of each role the consumers use;
   - terminate their existing sessions;
   - as a second layer, set `default_transaction_read_only = on` for the database.
   The setting alone is only a session default that a client can override, so the lockout is what guarantees that a late write fails instead of being lost.
3. **Copy:** `pg_dump --no-owner --no-acl` as a separate dump role, then restore as `substrate_owner`.
4. **Grant:** run the grants script.
5. **Verify** extensions and sequence values, and compare per-table row counts and checksums.
6. **Switch:** set the Vercel `DATABASE_URL` and `DATABASE_MIGRATION_URL`, then redeploy production so the new environment takes effect.
7. **Post-check:** an Exomem admission dry run, an Endstate backup read, and a Paddle webhook replay against the new database.
8. **Retain** Neon, locked out and read-only, as the rollback until retirement. Rolling back re-enables the application roles.

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
