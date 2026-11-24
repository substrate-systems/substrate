## Why

Exomem Cloud says nothing to its users about planned maintenance or incidents. A person whose assistant suddenly cannot reach Exomem can think that their memory is gone. The operator has no way to warn people before maintenance, or to tell them afterwards that an incident is over and their notes are safe.

## What Changes

- Add one record of service notices. A notice is planned maintenance or an incident. It covers the whole fleet or a named set of cells. The operator creates, cancels and resolves notices through one admin route. Nothing creates a notice automatically.
- Email the owner of each covered tenant once when maintenance is scheduled, and once when an incident that covered their cell is resolved. Both emails go through the existing email outbox and use the recipient's own time zone.
- While a notice is current, the Cloud gateway tells the cell through a new trusted request header. The cell adds a short `service_notice` field to every MCP tool result, so the connected assistant tells the person. The wording lives in substrate, beside the email copy.
- One operator script creates or ends a notice and mirrors it to the existing public status page (Upptime, `substrate-systems/exomem-status`). Maintenance becomes a scheduled-maintenance issue there; an incident becomes an incident issue. Full downtime reaches nobody over MCP, so the email and the status page cover it.
- Routine rolling cell upgrades, which the gateway hold already covers, create no notice.

## Capabilities

### New Capabilities

- `exomem-service-notices`: operator-declared maintenance and incident notices, the emails they send, and the notice the gateway passes to each covered cell.

### Modified Capabilities

None. The cell's handling of the new header is specified in the Exomem repository.

## Impact

- A migration that adds the notice tables and two kinds to `exomem_email_outbox_kind_check`.
- `src/lib/exomem-hosted/email-outbox.ts` and `src/lib/email-templates/exomem-lifecycle.ts` (two emails), a fan-out step in an existing cron route.
- `src/app/api/exomem/admin/service-notices` (operator route) and `src/lib/exomem-hosted/service-notices.ts` (the record and the operator operations).
- `src/exomem-gateway/cloud-handler.ts`: one cached lookup and one header per forwarded request, built in `src/lib/exomem-hosted/service-notice-header.ts`.
- `scripts/exomem-service-notice.ts` and `docs/runbooks/exomem-cloud-operations.md`, a new section "Service notices".
- The cell side ships separately in the Exomem repository. A cell without it ignores the header, so either side can ship first.
