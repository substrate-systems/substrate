# Design

## Context

The gateway already uses `/healthz` for pod liveness. The hosted control service has authenticated Kubernetes scheduler routes and a PostgreSQL adapter.
See proposal.md for motivation. The external site uses Upptime rather than a new monitoring service.

## Goals / Non-Goals

The design keeps public readers fast and places each reader near the component it measures.
It does not certify every customer cell, inbox delivery, OAuth issuance or semantic recall.

## Decisions

### Persist the latest completed proof

Use one `exomem_health_proofs` row per specified component, with `run_id`, `started_at`, `checked_at` and `success`.
Write one final result per attempt. Compare start times when replacing a row so a delayed run cannot conceal a newer failure.
The component set is a closed health protocol, not a vocabulary inferred from customer data.
Use database constraints and typed schemas for malformed input. Readers reject future or inconsistent timestamps.
Freshness is operational configuration tied to schedule cadence. Email has a maximum one-hour freshness limit.
Keep the latest failure instead of the source brief's older successful email observation; otherwise a confirmed send outage could remain green for an hour.

### Keep readers read-only and component-local

Control `/healthz` and `/healthz/email` read their respective proofs. Gateway `/healthz/canary` reads the memory proof.
Use a bounded database query and acquisition deadline. Public responses contain only the specified boolean body and disable caching.
Unavailability means the proof cannot certify the operation. It does not trigger a workload restart or deny user access.

### Reuse the scheduler and provider adapter

Add protected control and email jobs through the existing dedicated scheduler bearer and request contract.
The control check persists and reads a fresh value. Email uses `sendTransactionalEmail` with an explicitly configured synthetic recipient.
Success requires provider acceptance with its identifier; do not retain that identifier in public proofs.
Authentication prevents anonymous writes and billable sends. A false rejection costs the operator an unavailable observation and investigation.

### Use a bounded memory runner

Bundle a Node runner beside the gateway. A dedicated CronJob supplies a synthetic cell bearer and one mutable synthetic page.
Call existing MCP `edit_memory` with `replace_body`, including its preflight transition proof when required, then `read_memory`.
Parse structured results and compare the fresh nonce. Do not use message-text matching or create immutable source pages each run.
The runner does not receive the shared signing key or customer credentials. Its database permission covers the memory proof only.
The platform packet must include an explicit network allowance for only the synthetic cell.

### Preserve the probe routes

The public GET-only Traefik route rewrites `/healthz` to `/healthz/canary`. Pod probes bypass ingress and keep `/healthz` and `/readyz` unchanged.
If the rewrite cannot be deployed yet, the external site must show unavailable rather than substitute the pod probe.

## Risks / Trade-offs

- Shared PostgreSQL can make all proofs unavailable. Separate readers do not claim independent database availability.
- Scheduled checks are observations, not continuous guarantees. The public site reports the configured cadence and actual checked scope.
- A failed proof can be a check configuration failure. Operators investigate; no customer control depends on the public status result.

## Migration Plan

1. Apply the additive proof migration through the ordinary hosted release path; existing probes keep their responses.
2. Release the control readers and protected jobs; missing proofs remain unavailable.
3. Release the reviewed gateway image and platform packet through the existing deployment owner and approved window.
4. Provision the isolated synthetic page, bearer and grants; a scheduled write/read produces the first memory proof.
5. Publish the external site against exact functional routes; preserve actual failures and missing observations.

Rollback the application and scheduler packet independently. Leave the additive table in place; disabling checks makes proofs expire without changing customer state.
