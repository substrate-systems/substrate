## ADDED Requirements

### Requirement: Lifecycle operations persist one provisioner wire protocol

Every Exomem Hosted lifecycle operation SHALL durably store exactly one outer provisioner wire protocol before its first request. Existing operations SHALL be backfilled and server-defaulted to `exomem-cell-provisioner.v1`; new operations SHALL explicitly store v1 or v2. Every v2 lifecycle operation row MUST contain one complete existing target snapshot even when a later context-only provisioner subcall omits that target from its wire body, except a `delete` operation for a tenant with no cell whose only provisioner action is target-free tenant `destroy`. That narrow row SHALL retain immutable tenant, fence, idempotency, operation, and protocol identity and MUST NOT snapshot an unrelated candidate. The stored protocol and target or exception SHALL remain immutable across leases, waits, retries, restarts, feature-gate changes, and deployments, and SHALL remain independent from the Hosted runtime protocol.

#### Scenario: Existing operation resumes after upgrade

- **WHEN** a pre-migration lifecycle operation retries after the dual-protocol client is deployed
- **THEN** it emits the exact v1 header and body selected by its backfilled stored discriminator

#### Scenario: Gate changes during an operation

- **WHEN** a v2 operation is persisted and the issuance gate later becomes false
- **THEN** every retry remains v2 and does not reuse the idempotency key with a v1 envelope

#### Scenario: V2 row lacks a target

- **WHEN** an insert or update would leave a v2 lifecycle operation without a complete migration 0036 target snapshot
- **THEN** database constraints reject it before any request or side effect

#### Scenario: Tenant deletion has no cell

- **WHEN** a v2 delete operation is created for a tenant with no bound or retained cell and its only provisioner call is tenant `destroy`
- **THEN** the database accepts the exact target-free exception without assigning live-candidate lineage

#### Scenario: Provision attaches its operation-owned candidate

- **WHEN** a running v2 provision or restore operation at checkpoint `created` has already persisted its complete immutable target but has not yet created a cell
- **THEN** the database permits exactly one atomic attachment from a NULL `cell_id` to a newly selected same-tenant cell and may snapshot that tenant's same-tenant previously bound cell
- **AND** every detach, retarget, cross-tenant attachment, later-checkpoint attachment, or change to any other immutable operation identity remains rejected

### Requirement: V2 issuance is explicit and default-off

Only a trimmed case-normalized `true` value for the documented v2 issuance setting SHALL select v2 for a newly created operation. Missing, empty, malformed, or false values SHALL select v1. The setting MUST NOT retroactively alter an existing operation or act as runtime-protocol authority.

#### Scenario: Deployment omits the flag

- **WHEN** the dual-protocol consumer is deployed without a v2 issuance value
- **THEN** newly persisted operations continue using v1

#### Scenario: Operator enables v2

- **WHEN** the exact setting is explicitly true after D1 expansion proof
- **THEN** newly persisted operations use v2 while all existing operations retain their stored version

### Requirement: Protocol-specific codecs are strict and version-matched

Substrate SHALL send both protocols over the existing `/cells/<action>` routes with the exact matching provisioner protocol header. V1 serialization and parsing SHALL remain byte-compatible with the canonical v1 corpus. Cell-scoped v2 requests SHALL preserve existing action-specific fields while replacing flattened release/protocol identity with a strict six-field `runtimeTarget`. The context-only `export-delete`, `export-download`, and tenant `destroy` actions SHALL use explicit target-free v2 codecs. V2 health SHALL preserve existing liveness, readiness, cell, authentication, admission, worker-policy, and reason fields while replacing flattened release/protocol identity with the same six fields under `runtimeIdentity`; pending and non-health final shapes SHALL remain unchanged. Unknown fields, mixed envelopes, header/body disagreement, unbounded responses, and silent downgrade MUST be rejected.

#### Scenario: V2 request receives v1 health

- **WHEN** an operation sent the v2 header and target but receives a flat v1 health envelope
- **THEN** the client rejects the response and does not bind or activate the cell

#### Scenario: V1 fixture is replayed

- **WHEN** the client serializes every canonical v1 action after v2 support lands
- **THEN** the exact header and canonical body still match the frozen v1 corpus hash

#### Scenario: Target-free v2 action is issued

- **WHEN** an export-reference or tenant-destroy step uses a stored v2 discriminator
- **THEN** its body remains target-free and the exact v2 header still participates in idempotency and response selection

### Requirement: Runtime target comes from the immutable lifecycle snapshot

For v2, Substrate SHALL durably snapshot a complete candidate/runtime target for every cell-scoped lifecycle operation before first issuance. Provision and restore SHALL continue selecting the preparing assignment or live candidate; every other cell-scoped action SHALL resolve the authoritative candidate/runtime target behind the bound cell instead of process configuration. Substrate SHALL construct `runtimeTarget` from the stored source release, Hosted runtime protocol, supported agent profile, target gateway digest, command fingerprint, and agent schema digest. It MUST NOT send candidate IDs, assignment IDs, credentials, image references, compatibility digests, client package/archive locks, plugin provenance, OAuth metadata, or unknown fields. Context-only export-reference and tenant-destroy actions MUST NOT invent a target.

#### Scenario: Complete stored target is issued

- **WHEN** a new v2 lifecycle operation has a complete migration 0036 target snapshot
- **THEN** its request carries the exact corresponding six runtime fields and no catalog-only lineage

#### Scenario: Target snapshot is incomplete

- **WHEN** any required release, runtime protocol, profile, gateway, command, or schema value is absent or malformed
- **THEN** the operation fails closed before the provisioner or provider is called

#### Scenario: Bound-cell maintenance action is created

- **WHEN** quiesce, export, suspend, resume, seal, discard, or another cell-scoped action is enqueued for an authoritative bound cell
- **THEN** creation snapshots that cell's exact candidate/runtime target and retries never fall back to a process-wide release map

### Requirement: Runtime identity and compatibility use separate evidence

V2 readiness SHALL compare the returned six-field `runtimeIdentity` exactly to the stored target. Gateway, command, and schema observation columns SHALL record runtime measurements. Candidate compatibility and client package/archive/plugin/OAuth lineage SHALL remain authoritative only through the immutable candidate and staged-client catalogs and MUST NOT be accepted from provisioner health. Any database-required compatibility observation SHALL be derived locally from the selected candidate and labeled as catalog binding.

#### Scenario: Runtime identity matches but package evidence is absent

- **WHEN** a cell reports the exact runtime identity but the selected candidate lacks required client-package evidence
- **THEN** the cell may satisfy runtime readiness but candidate promotion remains blocked by the independent catalog evidence gate

#### Scenario: Health supplies compatibility data

- **WHEN** a v2 response adds a compatibility digest or package field
- **THEN** strict parsing rejects the envelope rather than treating it as runtime authority

### Requirement: Binding and promotion require full runtime identity

A lifecycle operation SHALL bind a replacement cell and activate an assignment only after authenticated v2 health reports all six target fields exactly. A one-field mismatch, omission, mixed-version response, or release text alone SHALL preserve the old safe binding or leave the tenant fail-closed. Offline restore, salvage, discard, and destruction authority SHALL not be derived from successful live health.

#### Scenario: One runtime field differs

- **WHEN** the returned release, runtime protocol, profile, gateway, command, or schema value differs from the immutable target
- **THEN** the replacement cannot bind and the assignment cannot activate or promote

#### Scenario: First strict-v1 marketplace reviewer cell

- **WHEN** an unexpired marketplace-reviewer tenant has the exact stored v1
  operation and marketplace-reviewer preparing or active assignment for a
  pending or live candidate, and strict v1 health proves its flat ready fields
  without a runtime identity
- **THEN** it may bind and activate without writing observed runtime digests,
  while the resulting routable cell remains ineligible as cohort promotion
  authority

#### Scenario: Runtime is unavailable during destructive recovery

- **WHEN** a correctly fenced discard or destroy proceeds while the cell cannot answer health
- **THEN** the operation does not manufacture readiness evidence and is not blocked solely by the missing live probe

### Requirement: Rollout preserves v1 until proven contraction

Substrate SHALL keep v2 issuance disabled until the exact dual-serving D1 provisioner, its bounded verified legacy-v1 catalog, and reviewed expand lock are live and every authoritative legacy unit plus synthetic v2 behavior are verified. Immediately before D1 takes traffic, the control plane SHALL hold the cohort/admission lock, freeze assignment and promotion changes, recompute the canonical routable/assigned/unfinished-v1 release-set digest, and require equality with the reviewed expand lock; mismatch SHALL abort cutover for regenerated/reviewed locks. The authenticated operator status SHALL expose only content-free contraction readiness: `unfinishedV1Operations` counts stored-v1 lifecycle operations other than `succeeded` and `failed_terminal`; `retainedV1Exports` counts non-deleted exports whose origin lifecycle operation stored v1; and `ready` is true only when both counts are zero. Contraction SHALL keep the expand lock and forbid deploying the reviewed contract lock while either count is nonzero, including v1-origin export download and export-GC continuations after their origin operation succeeds. Stored protocols MUST NOT be rewritten to satisfy the gate. Rollback SHALL be blocked while any v2 operation remains non-final, while any remaining cell/operation differs from the one rollback runtime unit, or until the exact D0/manifest/consumer tuple has passed its executable upgraded-schema replay rehearsal.

#### Scenario: D1 is not yet proven

- **WHEN** the consumer code is deployed before a successful D1 expansion probe
- **THEN** the issuance gate remains off and new operations continue v1

#### Scenario: D1 legacy catalog omits a current release

- **WHEN** a routable, assigned, or unfinished-v1 release/protocol pair has no unique verified entry in the expand lock
- **THEN** expansion preflight fails before D1 can replace the current provisioner

#### Scenario: Release set changes after lock review

- **WHEN** the canonical under-lock release-set digest differs from the digest stored in the reviewed expand lock
- **THEN** D1 does not take traffic and the lock pair is regenerated and reviewed before retry

#### Scenario: Legacy work remains

- **WHEN** fresh v1 work is still appearing or a v1 operation cannot be accounted for
- **THEN** the rollout remains in expansion and cannot claim contraction complete

#### Scenario: A retained v1 export remains after its operation succeeds

- **WHEN** an export whose origin operation stored v1 is not deleted, even if its lifecycle operation is `succeeded`
- **THEN** `retainedV1Exports` remains nonzero, `ready` is false, and contraction remains forbidden until its download/GC continuation drains

#### Scenario: Non-final v2 exists during rollback

- **WHEN** rollback preflight finds any unfinished v2 lifecycle operation
- **THEN** legacy provisioner rollback is forbidden until the operation is resolved or rolled forward

#### Scenario: Rollback unit has not passed rehearsal

- **WHEN** the exact D0 image, actual pre-D1 manifest, historical consumer, frozen corpus, or either upgraded schema was absent from the rehearsal
- **THEN** the tuple cannot authorize rollback

### Requirement: Migration and errors are side-effect-free

Migrations 0045 and 0047 and all protocol-admission failures SHALL create no assignment, provider action, OAuth lineage, candidate promotion, or tenant resource. Migration 0047 SHALL only correct the immutable trigger so the existing atomic candidate-creation path can attach one same-tenant cell to an otherwise immutable v2 provision or restore operation. Errors SHALL use bounded content-free diagnostics and MUST NOT reflect tenant data, credentials, contract bodies, package metadata, or provider details.

#### Scenario: Migration runs on an active database

- **WHEN** migration 0045 widens and constrains existing lifecycle operations
- **THEN** only the wire-protocol constraint and v2 target safeguards change and no external or control-plane action is triggered

#### Scenario: Attachment correction runs on an active database

- **WHEN** migration 0047 replaces the immutable trigger on a database containing existing v1 and v2 lifecycle rows
- **THEN** no row or external resource changes during migration and only the exact one-time candidate attachment transition becomes admissible

#### Scenario: Mixed envelope contains sensitive text

- **WHEN** strict parsing rejects a malformed response carrying unexpected sensitive content
- **THEN** logs and caller-visible status use only a bounded content-free code
