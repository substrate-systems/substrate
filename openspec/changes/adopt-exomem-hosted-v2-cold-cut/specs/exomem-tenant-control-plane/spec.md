## ADDED Requirements

### Requirement: The cold cut fences public control-plane mutation

The tenant control plane SHALL combine an external edge/WAF denial of
`/api/exomem/**`, disabled Hosted scheduler ingress, protected old Vercel URLs
or rotated old database/provisioner/Cloudflare Access credentials, and
`EXOMEM_HOSTED_COLD_CUT_MAINTENANCE=true` on every app process. The exclusive
cohort/admission advisory transaction lock serializes each mutation only; it is
not the global fence. While the external fence is active, it SHALL expose only
content-free maintenance/audit status and the exact reviewer-canary exception.
It SHALL record a repeatable-read snapshot with the exact current-state zero
predicates before migration/v2 startup. Only after that audit succeeds, it
SHALL capture the database restore point and bind its LSN/timestamp to the audit
snapshot before `0046` or any v2 mutation. It retains the fence until fresh v2
smoke or a verified rollback/restoration ends the window.

#### Scenario: A public write arrives during maintenance
- **WHEN** a Hosted public write or admission arrives while the cold-cut fence is held
- **THEN** the request is rejected without lifecycle, OAuth, client, reviewer, or provider mutation

#### Scenario: The exact smoke exception arrives
- **WHEN** the request is the pinned fresh reviewer-canary OAuth completion/token lineage or its newly minted canonical MCP bearer
- **THEN** it may run only for the one-window smoke
- **AND** it cannot mint refresh authority, use an old bearer, or select a route/profile

#### Scenario: The old cohort has not drained
- **WHEN** an audit finds a non-final operation, cell, assignment, export, transfer, reviewer authority, or reachable v1 OAuth/client lineage
- **THEN** the cut fails closed before migration or deployment

### Requirement: New processes issue only outer v2 work after the cut

After the narrow view migration and v2-only deployment, every newly started
process SHALL enable `EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED=true` and issue
the outer `exomem-cell-provisioner.v2` protocol for new work. The runtime
protocol remains the separately verified runtime value. The system SHALL not
retain absent/false v1 fallback, a stored v1/v2 coexistence model, or a
process-global rolling selector.

#### Scenario: All new processes satisfy the outer-v2 gate
- **WHEN** deployment admission evaluates every new process
- **THEN** each process has exact v2 issuance enabled and the verified v2 catalog loaded
- **AND** the deployment may proceed to fresh reviewer/client smoke

### Requirement: Reopen requires fresh v2 proof and rollback remains bounded

The control plane SHALL release the fence only after fresh reviewer bootstrap,
fresh client staging/promotion, and authenticated provision/bind/ready/client
smoke succeed against the verified v2 tuple and the canary exception has been
removed. Early configuration evidence and the post-fence database restore point
bound to the zero audit are both required. Before first v2 work it MAY restore
the old verified 0.39 stack. Once v2 work exists it SHALL require pair-bound,
proven-compatible v1 rollback runtime and a newly proven client cohort, or an
explicit operator-approved destructive restore with an acknowledged loss
boundary.

#### Scenario: Fresh smoke succeeds
- **WHEN** the fresh v2 reviewer/client lineage and authenticated smoke pass
- **THEN** the control plane records the proof and releases the public-write/admission fence

#### Scenario: A post-v2 rollback is requested without proof
- **WHEN** v2 work exists but pair-bound compatible-v1 rollback proof and fresh-client proof are absent
- **THEN** the control plane keeps the fence and refuses rollback
- **AND** it requires an explicit destructive restore path
