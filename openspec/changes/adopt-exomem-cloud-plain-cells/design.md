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

`redeemInviteAtomic` keeps its invite, account-block, tenant-dedupe and entitlement checks. It replaces the `live_target` snapshot and the cohort advisory lock with a capacity check: the count of non-deleted `exomem_cloud_cells` rows must be below the sum of `attachments_limit - attachments_used - headroom` over the published nodes. The check runs under a transaction-scoped advisory lock on `exomem-cloud-capacity`, before any write-bearing CTE, and surfaces as the existing typed `HOSTED_ADMISSION_CLOSED` 503 when full.

On success it inserts the tenant, the entitlement and a cells row with `desired_state = running` and `generation = 1`.

The OAuth invite path follows the same order. Capacity is checked before checkout so no one pays for a cell that cannot exist.

### D2. OAuth client admission for Cloud

`resolveApprovedOAuthClient` admits a client that is enabled, whose redirect digest matches, and whose CIMD metadata host is in `exomem_oauth_admitted_cimd_hosts` with fresh metadata. The whole-cohort `EXISTS` and the reviewer-credential branch do not apply to Cloud resources.

The Cloud MCP resource is a distinct configured resource URL (`EXOMEM_CLOUD_MCP_URL`). Tokens are issued for that resource only when the principal owns a non-deleted cell row.

### D3. The gateway is a pass-through

`src/exomem-gateway/server.ts` gains a Cloud handler for `EXOMEM_CLOUD_MCP_PATH` and serves the protected-resource metadata for that resource. For each request it:

1. rejects forbidden selector headers and applies the existing IP rate limit;
2. parses the bearer and looks up the access token for the Cloud resource, applying identity rate limits and concurrency guards;
3. resolves the principal's tenant and cell row, and refuses with 503 `CELL_NOT_READY` unless `desired_state = running` and `ready`;
4. derives the cell bearer (contract C3 in the Exomem design) from `EXOMEM_CLOUD_CELL_TOKEN_KEY`;
5. streams to `http://cell.exo-cell-<cell_id>.svc.cluster.local:8765/mcp`, forwarding only `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version` and `last-event-id`, adding `x-request-id`, and never forwarding the client's `Authorization`, cookies or forwarding headers.

Responses are `private, no-store`. Telemetry stays content-free, keeping the existing opaque identifiers and size and duration buckets.

The gateway image keeps the existing main-only publish workflow. The Exomem platform chart consumes it by digest.

### D4. Lifecycle is desired state

Every lifecycle transition is an `UPDATE` of `desired_state` that increments `generation`, and a trigger issues `pg_notify('exomem_cloud_cells', cell_id)`.

| Event | Desired state |
|---|---|
| Entitlement lapses or the account is suspended | `stopped` |
| Entitlement is restored | `running` |
| Account deletion | `deleted` |

The tenant's own content-free receipt is retained. Cloud cells get no lifecycle operation, reconciler claim, fence or provisioner call. The existing v1 queue stays dormant for legacy rows until retirement.

### D5. The release is one setting

`exomem_cloud_settings.cell_image` holds the digest. An owner-only admin route sets it. It also clears `rollout_paused` and can set a single row's `desired_image` for a canary. There are no candidate imports, promotion or fixtures.

### D6. The driver runs on standard Postgres

A single module exports `sql`, a tagged-template and `query(text, params)` function with the call shape the four modules use today, including `fullResults`. It is backed by one lazily created `pg.Pool` per process against `DATABASE_URL`, with TLS verify-full and a small `max` suited to serverless instances behind PgBouncer in transaction mode. No prepared statement outlives a transaction.

The four modules switch to it, and the `@neondatabase/serverless` dependency is removed. Behaviour against Neon stays identical until cutover, so this lands first.

### D7. Database roles

- Migrations run as `substrate_app`.
- The migration grants `exomem_gateway` `SELECT` on the token, tenant, entitlement and cell routing columns.
- It grants `exomem_cellctl` exactly the column privileges in the Exomem design (D11).

Grants are conditional on the role existing, so development databases still migrate.

## Shared contracts with Exomem

Contracts C1 (`exomem_cloud_cells`), C1b (`exomem_cloud_settings`), C1c (`exomem_cloud_capacity`) and C3 (gateway to cell) are defined in the Exomem design, and `migrations/0056_exomem_cloud_cells.sql` is their schema of record. The Exomem fixture copies it, and the local rehearsal runs this migration itself.

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
- **The capacity check under an advisory lock serializes admissions.** That is negligible at alpha volume.
- **Cutover correctness for Endstate.** The same `pg_dump`/restore carries Endstate tables. The cutover runbook verifies row counts and checksums, and exercises one Endstate backup read before re-enabling traffic.

## Migration Plan

1. The driver swap (D6, delivered by lane D2) is delivered and deployed against Neon with no behaviour change.
2. The migration, admission, client admission, gateway handler, lifecycle intent, settings and the operator view are delivered behind `EXOMEM_CLOUD_ENABLED`.
3. The local rehearsal runs.
4. The database cutover, the gateway deployment to the cluster, and enabling Cloud all happen at P4.
5. Rollback before enabling is to leave the flag off. After cutover, restore from the retained Neon export.
