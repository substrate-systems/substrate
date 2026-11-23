## Context

Exomem Cloud has three ways to reach a person: email through the outbox, the MCP results their assistant reads, and the public status page at `status.substratesystems.io` (Upptime, repository `substrate-systems/exomem-status`). Today none of them carries a maintenance or incident notice. Substrate has no notice, incident or maintenance record. The alert receiver stores raw alert transitions for the operator only. The cell takes its configuration from environment variables at start, so it cannot learn a live notice that way. The gateway already sends the cell trusted per-request headers (`x-exomem-oauth-client`, `x-exomem-client-context`, `x-exomem-app-id`).

Sources read first, from the roster's pick-by-problem table: "Context is wrong, bloated, stale, or missing" (Effective context engineering) and "The model keeps misusing a tool/MCP surface" (Writing effective tools for agents). Both favour short, high-signal context delivered in the tool result when it is needed, over static text loaded once.

## Goals / Non-Goals

**Goals:**

- One operator action declares maintenance or an incident, and every channel follows from it.
- A covered person hears about maintenance before it starts, and hears that an incident is over.
- A connected assistant tells the person about a current notice in its next answer.
- No notice claims maintenance or an incident that the operator did not declare.

**Non-Goals:**

- Automatic incidents from alerts or health proofs. An alert is a raw operator signal, and a notice made from it could claim an outage that no person saw. A later change can add it.
- Notices for routine rolling upgrades. The gateway hold already covers them.
- A cancellation email after a maintenance email went out. The status page and the MCP notice show the truth.
- Changing the MCP server instructions. They are a static text of at most 900 characters that clients read once at initialize, so they cannot carry a notice that starts later.

## Decisions

### D1. One notice record, set only by the operator

`exomem_service_notices` holds `id`, `kind` (`maintenance` or `incident`), `summary` (operator text, at most 280 characters), `starts_at`, `ends_at`, `announce_from`, `cancelled_at`, `resolved_at` and timestamps. `exomem_service_notice_cells` lists the covered cells; a notice with no rows covers the whole fleet. A notice has no stored state column; its state follows from its times:

- maintenance is **scheduled** from `announce_from` (default `starts_at` minus 48 hours) to `starts_at`, **active** until `ends_at`, and **over** afterwards or once cancelled;
- an incident is **active** from `starts_at` until `resolved_at`.

`kind` is a closed set that this specification fixes, because each kind sends different emails and follows different rules. It is not customer data.

The operator route `src/app/api/exomem/admin/service-notices` takes `EXOMEM_ADMIN_TOKEN` through `requireRateLimitedExomemOperator`. It creates a notice, lists current and recent notices, cancels maintenance that has not ended, and resolves an incident. A resolved or cancelled notice cannot change again.

### D2. Emails ride the existing outbox

Two kinds join the registry: `maintenance_scheduled` and `incident_resolved`. Each uses `defineEmail` with `stillHolds` re-reading the notice, so a cancelled or ended maintenance sends nothing. The dedupe key is `service-notice:<notice id>:<tenant id>`, so each owner gets each email at most once.

Fan-out runs in the existing delivery cron, not in the operator request. Each tick takes at most one bounded batch per notice of covered tenants that have no outbox row yet. It finds them with one anti-join on the dedupe key and inserts them in one multi-row statement. A tick never runs one query per tenant. The batch size is a named constant with a one-line reason. Covered tenants are those whose cell is not deleted and whose owner has an email address; the owner's current address is read at send time, as other account emails do.

A maintenance email is enqueued only while the maintenance is scheduled. An incident email is enqueued only after the incident is resolved.

### D3. The gateway passes the notice in one header

For each forwarded MCP request, the gateway finds the current notices that cover the request's cell. When at least one is current, it sets `x-exomem-service-notice`: base64url of UTF-8 JSON, at most 1,024 bytes, with this shape:

```json
{"v":1,"kind":"maintenance","state":"scheduled","starts_at":"2026-11-25T02:00:00Z","ends_at":"2026-11-25T02:30:00Z","say":"..."}
```

`say` is addressed to the assistant, at most 400 characters. It begins "Tell the user once in this conversation: ", as Exomem's other `say` fields address the agent, because a real-model replay relayed a notice worded that way more reliably than one worded as a statement. Substrate composes it from the notice and the status page address, so all user-facing wording stays in one repository. When several notices are current, the gateway sends the one that matters most: an active incident, then active maintenance, then the earliest scheduled maintenance.

The gateway reads all current notices and their cells in one query and keeps the result in process memory for at most 30 seconds. A new or ended notice reaches every gateway instance within that time. The header never carries tenant data. Callers cannot send it: the gateway already refuses any caller header that starts with `x-exomem-`.

The status page address is configuration (`EXOMEM_STATUS_PAGE_URL`), with the current address as its default.

### D4. The status page follows from the same action

`scripts/exomem-service-notice.ts` is the operator's one command. It calls the admin route, then mirrors the notice to `substrate-systems/exomem-status` with the operator's own `gh` login:

- maintenance opens an issue labelled `maintenance` whose body starts with Upptime's `<!-- start: … end: … expectedDown: … -->` block; cancelling closes it;
- an incident opens an issue labelled `status` and with the slug of the affected status line; resolving closes it with a one-line account of what happened.

Substrate holds no GitHub credential. The public issue never names a tenant or a cell.

## Scale and latency

No load target is recorded for Exomem Cloud yet. This design assumes up to 10,000 tenants and at most a few current notices at a time.

- Gateway: the added cost per forwarded request is one in-memory lookup. The added database work is one query per gateway instance per 30 seconds, whatever the request rate, and none while the instance has no traffic. The one request that finds the copy older than 30 seconds waits for that query, bounded by a 5-second timeout. The budget is under 1 ms at p95 per request on a gateway with steady traffic.
- Fan-out: 10,000 tenants send in about 50 ticks at a batch of 200. The outbox drains as it does now.
- Admin route: operator-only and bounded; the list returns current notices and the newest 50 others.

## Risks / Trade-offs

- An operator types a wrong time or the wrong cells, and the emails go out. A real send cannot be recalled. Mitigation: the script prints the covered tenant count and the composed `say` text and asks for confirmation before it creates the notice. Maintenance emails start at the next delivery tick, not inside the request.
- The cache delays a new notice by up to 30 seconds. That is acceptable for notices that are scheduled hours ahead or that follow an incident.
- A cell on an older image ignores the header, so the MCP notice appears only after the Exomem cell release.
