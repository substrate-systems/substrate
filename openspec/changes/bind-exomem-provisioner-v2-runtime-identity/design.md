## Context

Substrate currently sends every lifecycle request with `X-Exomem-Provisioner-Protocol: exomem-cell-provisioner.v1`. Its internal request and health types mirror the flat v1 wire shape, and the fake provisioner hashes only that body for idempotency. Migration 0036 already snapshots the selected candidate, source release, Hosted runtime protocol, gateway digest, command fingerprint, schema digest, and compatibility digest on lifecycle operations and keeps package/archive/plugin/OAuth lineage in candidate and staged-client tables.

The outer provisioner wire protocol is not the Hosted runtime protocol: v2 requests will still target runtime protocol `"1"` and `/private/exomem/v1/...`. The paired Exomem change dual-serves the same `/cells/<action>` routes and returns runtime-only observations. Substrate must preserve v1 retries while moving only new work to v2.

## Goals / Non-Goals

**Goals:**

- Serialize and parse strict v1 and v2 provisioner contracts without changing v1 bytes.
- Persist the selected outer protocol before first issuance and keep retries stable across restarts, deployments, and flag changes.
- Snapshot and build v2 `runtimeTarget` for every cell-scoped lifecycle action from the existing immutable target columns and validate v2 `runtimeIdentity` without duplicating lineage state.
- Keep v2 default-off until the dual-serving provisioner and reviewed deployment lock are live in expand mode.
- Preserve package compatibility as local catalog authority rather than cell evidence.

**Non-Goals:**

- Adding another target or observation JSON blob, duplicating migration 0036 digest columns, or copying package/archive locks into lifecycle operations.
- Changing the runtime protocol, private cell routes, public MCP contract, tenant selection, OAuth lineage, or candidate promotion requirements.
- Auto-detecting response versions, silently downgrading, or choosing protocol from every retry's current environment.
- Using a live runtime probe as a prerequisite for offline recovery or destruction.

## Decisions

### Keep one internal model with exact protocol-specific codecs

The client retains one normalized internal lifecycle target but uses separate closed serializers and response parsers selected by the operation's stored outer protocol. V1 emits the current flat body and exact v1 header unchanged. V2 emits the same action context with a required `runtimeTarget` containing exactly:

- `releaseVersion`
- `protocolVersion`
- `agentProfile`
- `gatewayContractDigest`
- `commandFingerprint`
- `schemaDigest`

V2 retains every existing action-specific context, credential, worker-policy, provider-reference, pending, and non-health final field, replacing only the legacy top-level release/protocol identity on cell-scoped calls with `runtimeTarget`. The context-only `export-delete`, `export-download`, and tenant `destroy` calls use explicit target-free v2 codecs. V2 health retains the existing liveness, readiness, cell, authentication, admission, policy, and reason fields while replacing flattened release/protocol identity with the six fields under `runtimeIdentity`. The parser does not inspect body shape to guess a protocol and never accepts a flat v1 response to a v2 request or vice versa. The fake provisioner includes both the stored protocol and canonical envelope in its idempotency identity.

### Migration 0045 widens the outer discriminator

Migration 0039 adds `provisioner_wire_protocol` to the lifecycle-operation table, backfills and server-defaults existing rows to `exomem-cell-provisioner.v1`, and makes the selection immutable. Migration 0045 widens that existing constraint to the two exact supported literals and requires every v2 lifecycle operation row to carry a complete existing target snapshot except the narrow case of a `delete` operation whose tenant has no cell and whose only provisioner action is target-free tenant `destroy`; that row retains immutable tenant/fence/idempotency/protocol audit identity and MUST NOT be assigned an unrelated live candidate. Migration 0045 creates no provider action, assignment, OAuth state, candidate promotion, duplicate identity column, or replacement immutable trigger.

The v1 default is permanent so old rows and rolling binaries remain compatible. New code explicitly writes v2 only when creating a new operation after the gate is enabled. For every new v2 operation that has a cell, the same creation transaction also fills the existing migration 0036 target columns from the authoritative candidate/assignment or currently bound-cell catalog state. A no-cell tenant deletion records the narrow target-free exception. Reconciler retries always load the stored discriminator and target/exception; they do not evaluate the flag or process release configuration again.

### V2 issuance is fail-closed and default-off

`EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED` follows the existing environment pattern: only a trimmed, case-normalized `true` enables v2. Missing, empty, malformed, or false values select v1. The setting affects new lifecycle-operation creation only.

This permits the consumer code and migration to deploy before D1, and D1 to deploy in expand mode before issuance changes. A global per-request selector was rejected because it changes the request identity for an existing idempotency key.

### Existing migration 0036 state supplies the target

The lifecycle snapshot remains the authority for candidate selection. Provision/restore keep their current assignment-or-live selection. Every other cell-scoped action resolves the immutable candidate/runtime target behind the authoritative bound cell and snapshots it before first issuance rather than falling back to process configuration. Context-only export-reference and tenant-destroy calls require no target. V2 maps the stored values as follows:

- source release -> `releaseVersion`
- runtime protocol -> `protocolVersion`
- fixed supported profile -> `agentProfile`
- target gateway digest -> `gatewayContractDigest`
- target command fingerprint -> `commandFingerprint`
- target agent schema digest -> `schemaDigest`

`target_compatibility_digest` remains part of the candidate/lifecycle catalog snapshot but is not sent. Candidate IDs, assignment IDs, credentials, image references, package locks, and plugin/OAuth metadata also remain outside `runtimeTarget`.

### Health observation is runtime-only

For v2, readiness compares the exact returned runtime identity to the six-field target. Existing observed gateway/command/schema columns store cell measurements. If migration 0036's all-or-none constraint requires `observed_compatibility_digest`, the lifecycle store derives it from the immutable selected candidate in the same transaction and documents it as catalog binding rather than cell observation.

Candidate assignment and promotion still validate compatibility/package evidence through the existing candidate and staged-client rows. The provisioner response cannot satisfy those checks.

### The canonical corpora bind TypeScript to Python

The existing v1 fixture remains byte-for-byte unchanged and retains SHA-256 `ced714a5aa204a837e22cab831262cc0ae4766e44720b2896e61b8c157ddd3b5`. A separate v2 fixture covers every action, exact header, pending/final response, malformed mixed envelope, and replay failure. Tests consume the Exomem corpus directly when available in the paired workspace or a checked-in copy whose SHA-256 is pinned in both repositories.

### Rollout is expand then contract

The operational order is:

1. Compose D1's bounded legacy-v1 catalog from every release/protocol unit currently routable, assigned, or referenced by unfinished v1 work and record the canonical set digest in both phase locks.
2. Immediately before cutover, hold the cohort/admission lock, freeze assignment and promotion changes, recompute the set digest, and abort for lock regeneration/review on mismatch; on match, move traffic to D1 with the reviewed expand lock before releasing the freeze.
3. Prove every cataloged legacy v1 unit plus a synthetic v2 request/health round trip.
4. Deploy this Substrate migration and consumer with v2 issuance disabled.
5. Enable v2 for new operations; existing operations retain stored v1.
6. Keep the reviewed expand lock until the content-free operator contraction
   readiness view reports both `unfinishedV1Operations = 0` and
   `retainedV1Exports = 0`. The first counts stored-v1 operations excluding
   `succeeded` and `failed_terminal`; the second counts all non-deleted exports
   whose origin operation stored v1. This deliberately retains v1-origin export
   download and export-GC continuations after their export operation completes.
   Do not rewrite a stored protocol to satisfy either count.
7. Deploy the reviewed contract lock only after that drain proof.
8. Canary a fresh v2 lifecycle through readiness, binding, activation, and promotion.

Rollback is not a flag flip for in-flight work. Before acceptance, the exact D0 image, actual pre-D1 manifest, last-known-good Substrate commit, frozen corpus, and both upgraded schemas pass an executable rehearsal. Rollback then uses only that tuple after admission stops, both systems prove no non-final v2 operation exists, and remaining cells/operations match its one legacy unit.

## Risks / Trade-offs

- [A retry changes versions after a deploy] -> Store the discriminator before first issuance and use only stored state for retries.
- [V1 serialization drifts during refactoring] -> Keep the v1 corpus byte-exact and test every request plus header.
- [Compatibility is accepted as cell evidence] -> Remove it from v2 wire parsing and resolve it only from the candidate catalog.
- [A fourth release-to-contract mapping appears] -> Build v2 targets from the existing lifecycle snapshot and candidate/catalog joins rather than a new hard-coded map.
- [The gate enables before D1] -> Default off, require the documented expand preflight, and have mixed-envelope requests fail closed.
- [D1 rejects a currently live v1 release] -> Require its verified legacy catalog to cover authoritative routable/assigned/in-flight state before expansion.
- [The legacy release set changes after review] -> Compare the canonical set digest under the cohort/admission lock with assignment/promotion changes frozen through traffic cutover; regenerate/review on mismatch.
- [A maintenance operation lacks migration 0036 target data] -> Snapshot the bound cell's authoritative candidate target for every cell-scoped action; use target-free v2 only for the three context-only calls.
- [A tenant deletion has no cell] -> Allow only the exact no-cell delete exception and retain tenant/fence/idempotency/protocol audit identity without inventing candidate lineage.
- [Old rows fail during rolling migration] -> Backfill and retain a server-side v1 default with an allowed-value constraint.
- [Contraction strands v1 work] -> Observe creation rates and durable operation state before deploying the immutable contract lock.
- [Pinned rollback metadata is not executable] -> Rehearse the exact D0/manifest/consumer unit against upgraded schemas and corpus before accepting it.

## Migration Plan

1. Land the paired Exomem and Substrate specifications.
2. Add protocol codecs and tests while v2 issuance remains off.
3. Apply migration 0045 and deploy the consumer with the flag absent/false.
4. Follow the exact expand/contract sequence after D1, its authoritative legacy catalog, and the reviewed phase-lock pair are verified.
5. Keep the migration additive and the v1 default permanent for rollback compatibility.

## Open Questions

- The exact D1 digest, final deployment-lock digest, and rollback Substrate commit are supplied only after their reviewed builds/merges. They cannot be placeholders in production configuration.
- Live enablement requires operator deployment credentials, capacity/cost approval, and rollout evidence; repository checks alone do not satisfy that gate.

## Strict-v1 reviewer compatibility addendum

Until strict v2 codecs are issued, a stored `exomem-cell-provisioner.v1` operation
may bind the first marketplace-reviewer cell without manufacturing a runtime
identity. The database stores the immutable outer wire discriminator, currently
constrained to the exact v1 literal; the later dual-protocol migration widens
that constraint. Strict v1 health remains identity-less and must prove the
authenticated flat cell, release, runtime protocol, admission, worker-policy,
and ready-code fields. Any v1 health envelope carrying `contractIdentity` is a
mixed envelope and fails closed.

The lower-assurance bind is limited, under the existing cohort lock, to an
unexpired marketplace-reviewer tenant and its exact marketplace-reviewer
`preparing` or `active` assignment, candidate, and generation. It writes the
selected immutable target to the routable catalog as expected routing metadata,
but leaves all observed runtime digest columns NULL. Full exact observations
remain mandatory for ordinary binds and for every routable cell used as cohort
promotion authority, so a v1 reviewer cell can never promote a candidate.
