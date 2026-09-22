## Why

Exomem Hosted has spent more than a month without admitting a single user. Every launch failure lived in the admission and trust layer:

- live cohorts, contract candidates, rollout assignments and client artifacts;
- promotion and reviewer bootstrap;
- per-release contract fixtures (162k lines);
- a fenced lifecycle queue driving a provisioner that has to prove each step.

An empty fleet could not admit its first user, because every admission path needed a live cohort, and a cohort needed a cell.

Exomem Cloud replaces that layer:

- A cell is standalone Exomem, so it serves its own MCP surface.
- The gateway only authenticates, routes and forwards.
- Admission is an invite, an entitlement and a capacity check.
- Cell lifecycle is a desired-state row that the in-cluster controller converges.

Neon is replaced by our own Postgres.

## What Changes

- **Admission.** An invite, a session, an entitlement and a capacity check create a tenant and an `exomem_cloud_cells` row with `desired_state = running`. No live-target, cohort or contract predicate participates.
- **OAuth client admission.** It keeps the approved CIMD host allowlist, redirect validation and client enablement, and drops the cohort `EXISTS` and reviewer-credential branches for Cloud.
- **Pass-through gateway.** It runs in the Exomem cluster from `src/exomem-gateway`. It authenticates the OAuth access token, derives the tenant and cell from the principal, and streams MCP bytes to the cell with the derived per-cell bearer. It keeps rate limits, concurrency guards and content-free telemetry. It does no contract fetch, digest comparison or private command routing.
- **Lifecycle as desired state.** Suspension, resumption and deletion become writes to the row's desired state. The in-cluster controller converges them, so Cloud cells need no provisioner calls, no reconciler lease and no fence.
- **Release setting.** The Cloud release is the `cell_image` setting. Nothing else is adopted per release.
- **Driver swap.** Every `neon()` HTTP driver call becomes a `pg`-backed adapter with the same call shape, so the application runs against standard Postgres.
- **Owner-only operator view.** It shows each cell's observed state, the rollout setting and published capacity.

## Capabilities

### New Capabilities

- `exomem-cloud-control-plane`: Admission, client admission, gateway, lifecycle intent, release setting and database portability for Exomem Cloud.

### Modified Capabilities

None in this change. The retirement phase removes the superseded `exomem-hosted-*` requirements together with their code.

## Impact

- **Code:**
  - `src/lib/exomem-hosted/{access,db,oauth-store,paddle-event-store}.ts` and `src/lib/hosted-backup/{db,claim-tokens}.ts`, for the driver;
  - `src/exomem-gateway/`;
  - a new `src/lib/exomem-cloud/` module;
  - a migration `0056_exomem_cloud_cells.sql`;
  - Home status.
- **Companion change:** the Exomem change `adopt-exomem-cloud-plain-cells` owns the cell runtime, cellctl, manifests, ingress, the control-database server and the node rollout.
- **Unchanged:** billing semantics, the website, the Endstate products and the OAuth authorization server endpoints.
