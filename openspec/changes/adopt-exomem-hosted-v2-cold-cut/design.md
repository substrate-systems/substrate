## Context

PR #89 added the outer `exomem-cell-provisioner.v2` wire while preserving the
old Hosted deployment. The rejected adoption proposal extended that into a
rolling two-cohort migration. Friends alpha does not need that complexity, and
it would leave too much authority live while new code is promoted.

This change is a cold cut. The active target is deliberately **not** fixed
until the latest signed post-fix upstream release and its assets exist. Phase B
currently expects `0.49.0`, but that is an expectation rather than a pin: all
release-dependent values are re-derived from the selected signed assets,
independently verified, and then pinned in the reviewed
change/configuration before live execution. No value in the following table is
an active target:

| Rejected 0.48.0 baseline only | Value |
| --- | --- |
| source commit | `10e091fc6eff023dd56cef4cd9aafa3910065178` |
| private gateway contract digest | `c7799706ae4fefdc9258bab605eb5a7c0444f63f15db6a64a454e78bd280a51d` |
| agent runtime contract digest | `d313125e3068258b907fea1b6f9b26bb6656c483995036490773e0b67d3b281d` |
| command fingerprint | `9397885e979200ea9f72251fcffbe35042ad41addf4df79051f2e066da04923e` |
| schema digest | `a64787a1e1dda6d4cae2e7315d1532f42f70b374bdef4d23e3025cb98eb41504` |
| compatibility digest | `b9d92ba281245b9d4fe98217da8056568243093cf312c9102ddeec7365257362` |
| forward-contract artifact digest | `faa982ca1e54f140e407545f3e6618f98d10026ac60343a2f81b4a05c657a8a3` |
| deployment-lock-pair bytes / schema version | `643e69545ec851a4767037a4e450b3d5618d604fa789f99f8ead77c5d64d0388` / `3` |
| composition artifact Git provenance | `581c241e` |
| plugin version | `0.2.0` |

The old incorrect `18325…` value is forbidden. The private gateway digest and
agent runtime digest are different domains and are checked separately. The
outer provisioner wire version is not the runtime protocol version. The runtime
is the source only for the private gateway contract, agent runtime contract,
and command fingerprint it actually reports. The schema and compatibility
digests are upstream release/compatibility artifacts verified from the release
bundle; they are not inferred from a health response or substituted with the
agent runtime contract digest.

## Goals / Non-Goals

**Goals:**

- Move a closed friends alpha to exactly one freshly verified v2 cohort.
- Prove that no old work, authority, or reachable client path survives before
  catalog replacement.
- Make every mutable live step fenced, observable, and abortable.
- Leave a recovery route whose compatibility claims are proven, never assumed.

**Non-Goals:**

- The rejected profile-aware `0046` design: `target_agent_profile`, lifecycle
  backfill/defaults, or mixed-profile lifecycle state. The replacement 0046
  migration is limited to the singleton-view swap below.
- Simultaneous v1/v2 routing, rolling deployments, global cohort CAS, or
  cross-profile descendant/lineage checks.
- Reusing old reviewer, OAuth, staged-client, assignment, transfer, or export
  state.
- Public launch, billing, or expired-reviewer incident recovery.

## Decisions

### The maintenance window is an executable external fence

The operator first applies an externally enforced fence, not merely a database
lock: an edge/WAF rule denies `/api/exomem/**`; Hosted schedulers are disabled;
and every old Vercel deployment URL is either protected from public access or
the old database, provisioner, and Cloudflare Access credentials are rotated
before it can reach an origin. Every newly deployed app process has
`EXOMEM_HOSTED_COLD_CUT_MAINTENANCE=true`, which independently rejects Hosted
mutations even if an edge rule is misconfigured. Read-only status may state
maintenance without leaking internal identity.

The only temporary edge/app allowlist is the exact fresh reviewer-canary OAuth
and MCP smoke: its one new bootstrap authority, one staged new client, exact
canonical resource, opaque one-window canary capability, and expiry are pinned
before the exception. OAuth endpoints accept only that exact fresh transaction
lineage; MCP accepts only the newly minted bearer for that lineage. The
exception allows no general OAuth, public write, route selector, refresh, or
old bearer. It is removed on either smoke completion or abort.

`pg_advisory_xact_lock` remains useful only to serialize each individual
operator mutation and its audit write. It is not a global maintenance fence and
cannot substitute for the edge, scheduler, deployment, and app fences. The
external fence remains in place until either fresh v2 smoke succeeds and the
alpha reopens, or a verified rollback/restoration completes.

Before migration or catalog replacement, a single repeatable-read snapshot
taken after old replicas drain must show zero current legacy authority, while
permitting inert history. Exact predicates are: lifecycle operations whose
state is not `succeeded` or `failed_terminal`; cells whose `lifecycle_state`
is not `deleted`; rollout assignments in `preparing` or `active` with
`expires_at > snapshot_now`; exports whose state is not `deleted`; transfer
grants whose `consumed_at` and `revoked_at` are both NULL and `expires_at >
snapshot_now`; reviewer credentials with `revoked_at IS NULL AND expires_at >
snapshot_now`; bootstrap authorities in `active` with `expires_at >
snapshot_now`; and legacy-path client/OAuth authority.

The latter counts enabled v1-reachable clients, non-retired v1 client artifacts
or staged releases, unconsumed/unexpired authorization transactions/codes,
unrevoked grants, unrevoked/unexpired token families, unconsumed refresh tokens
whose family remains current, unrevoked/unexpired access tokens, and unrevoked
unexpired browser sessions. The predicates are recorded with the snapshot time
and row counts; historical terminal operations, deleted cells/exports, expired
or consumed credentials, revoked grants/tokens, and retired artifacts do not
block the cut. Any non-zero current predicate aborts it; no destructive cleanup
is implicit in this change.

### Replace the singleton view; do not persist a second profile

The only schema change is a new tiny `0046` migration. Earlier `0031` and
`0032` migrations are immutable history and SHALL not be edited. `0046`
replaces the latest `0034` definition of `exomem_hosted_alpha_cohort` byte-for-
byte in structure and joins except for its final v2 profile predicate. It
creates neither lifecycle target columns nor a v1 backfill, and it has no
control-plane/provider side effect. Existing database constraints continue to
protect immutable lifecycle facts; the closed-window assertions mean there is
no legacy work that needs a second identity model.

After the migration, process-global catalog, private route mapping, fixtures,
and test factories are v2-only. No process can derive a route/profile from a
request, old record, or environment fallback. The public MCP route remains
compatible at its published URL but resolves only the active v2 catalog after
authoritative tenant/cell mapping.

### Derive the active release tuple from complete, separate evidence

For the latest signed post-fix release selected in Phase B (currently expected
to be `0.49.0`), the release tag/signature and release assets are verified using
their actual upstream signature mechanism. SHA-256 digests are integrity
identifiers, not signatures; “signed” is used only where a cryptographic
signature has actually been verified. Four independent evidence records are
required and none may borrow a digest from another domain:

1. **Runtime**: signed-release source provenance, runtime image manifest digest,
   private gateway contract digest, distinct agent runtime contract digest, and
   command fingerprint self-reported by the running exact image.
2. **Provisioner**: provisioner source provenance, provisioner image manifest
   digest, supported outer wire corpus/version, and the exact runtime identity
   it sends and validates.
3. **Composition**: reviewed composition Git provenance, forward-contract
   artifact SHA-256, deployment-lock-pair byte SHA-256 and schema version, and
   the deployed manifest/chart digest.
4. **Clients**: Claude and OpenAI package/archive SHA-256s, plugin version,
   OpenAI registered-app digest, exact client configuration digest, and digital
   signature verification only where the corresponding upstream/client artifact
   is actually signed.

The schema and compatibility digests come from the verified upstream
compatibility/schema artifacts in the release bundle, not runtime health. All
four complete records are then pinned exactly.

Only after this exact self-digest verification does Substrate derive its
release-independent schema projection. That projection is a deterministic
mapping from the verified contract shape to Substrate's gateway schema; it does
not bake a release number or copied digest into gateway code. A mismatch,
missing signature where the release declares one, unverified provenance, or
non-deterministic projection aborts before any catalog mutation.

### Fresh authority and outer-v2-only issuance

Once the audit and release verification pass, every newly started Substrate
process sets `EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED=true`; deployment checks
fail closed if any process is absent, false, malformed, or still configured for
the old catalog. The runtime protocol remains whatever the verified release
declares; it must not be inferred from the outer wire version.

The cut has one bounded operator-control maintenance capability to break the
otherwise circular fence/bootstrap dependency. It is created only after the
post-release tuple is verified, binds that one immutable tuple and the raw
artifact payload below, and is accepted only by the protected operator-control
path while the external fence is held. Each permitted mutation takes the
advisory transaction lock and revalidates the entire tuple. The capability may
perform only this ordered sequence: exact pending candidate import, fresh
Claude/OpenAI staging, then fresh reviewer bootstrap. It cannot promote, issue
ordinary work, mint general OAuth, select routes, or touch legacy state. It is
consumed when the final bootstrap step commits and is revoked/removed on any
abort; it cannot be reused or revived.

The raw artifact payload includes, as independent fields, the raw compatibility
artifact SHA-256 and all four raw lock-file SHA-256s (Claude package lock,
Claude archive lock, OpenAI package lock, OpenAI archive lock), in addition to
the package/archive artifact hashes carried by those locks. It also carries the
exact client configuration and registered-app values. No lock digest may stand
in for another lock or for the compatibility artifact.

The fresh reviewer bootstrap, staged Claude/OpenAI client records, OAuth
transactions/grants/token families, and client locks are created exclusively
from the new active tuple. They never import or upgrade an old row. The exact
promotion order is: (1) verify the complete raw artifact payload; (2) import
the pending candidate through the maintenance capability; (3) stage Claude and
OpenAI; (4) bootstrap the reviewer; (5) run the one-window OAuth/MCP smoke and
record both clean-client evidence; (6) in one locked transaction promote the
candidate, then the paired client artifacts, then retire the consumed staging
and assignment records; and (7) remove the smoke exception before reopening.
“Signature verified” is recorded only for artifacts with a verified digital
signature; digest-only artifacts are recorded as digest verified.

### Reopen and rollback are explicit

Before reopening, a fresh reviewer/bootstrap, staged client promotion, and
authenticated end-to-end provision/bind/ready/client smoke must pass against
the v2-only catalog. Then the operator releases the public-write/admission
fence and records the release tuple, window evidence, and smoke result.

Rollback has three durable boundaries and two distinct pre-cut records. Before
fencing, the operator may capture immutable deployment/configuration manifests,
credential rotation state, and proof of the old 0.39 operational bundle. This
early record deliberately excludes a database restore point. Only after edge,
scheduler, old-deployment/credential, and app fences are confirmed; every old
replica is drained; and the repeatable-read zero-state audit succeeds, the
operator captures the database restore point. Its database LSN and timestamp
are bound to that exact audit snapshot/time and recorded before migration or
any v2 mutation. Neither record by itself is a rollback claim.

1. **Before first v2 work**: restore the verified old 0.39 stack from that
   snapshot only after the external fence is still effective.
2. **After v2 work, with proof**: use only a pair-bound, proven-compatible v1
   rollback runtime and newly proven client cohort. It may not claim that the
   old 0.39 stack is compatible.
3. **After v2 work, without that proof**: use an explicit operator-approved
   destructive restore, including the snapshot/backup evidence, confirmed data
   loss boundary, and a fresh authority rebuild. It is not an automatic
   fallback.

## File-level implementation plan

| Files | Change |
| --- | --- |
| `migrations/0046_exomem_hosted_v2_cold_cut.sql` and migration tests | Preserve immutable `0031`/`0032`; replace only the latest `0034` cohort view, identically except for the v2 profile predicate; assert no lifecycle/backfill/profile mutation or side effects. |
| `scripts/generate-exomem-hosted-contract.mjs`, `agent-contract-fixture.ts`, `agent-contract-store.ts`, `agent-contract-canaries.ts`, `provisioner-wire-protocol.ts`, `provisioner.ts`, cross-language/catalog tests | Re-derive and pin separate runtime, provisioner, composition, and client evidence; reject `18325…`; produce a v2-only catalog and deterministic schema projection. |
| `src/app/api/exomem/**`, `src/app/.well-known/**`, `gateway.ts`, `mcp.ts`, `oauth.ts`, `oauth-http.ts`, `oauth-store.ts`, `sessions.ts`, route tests | Apply maintenance guards and the exact reviewer-canary OAuth/MCP exception; map authoritative requests to one v2 route and reject old/private caller selection. |
| `src/app/api/cron/exomem-reconcile/route.ts`, `exomem-export-gc/route.ts`, `exomem-access-delivery/route.ts`, scheduler configuration, `scheduler-auth.ts`, tests | Disable scheduler ingress before the cut and prove cron cannot mutate during maintenance. |
| `operator-controls.ts`, `operator-admin.ts`, `operator-observability.ts`, `oauth-admission.ts`, `reviewer-access-store.ts`, `client-artifacts.ts`, `account-install-actions.ts`, `cloudflare-access.ts`, runbook, tests | Implement external-fence evidence, same-snapshot predicates, fresh authority, release verification, and reopen records. |
| Vercel deployment/edge-WAF configuration, Cloudflare Access configuration, deployment/configuration tests | Deny `/api/exomem/**`, protect old deployment URLs or rotate old DB/provisioner/CF credentials, and require outer v2 issuance true on every new process. |
| end-to-end/real-Postgres fixtures and rollback tests | Exercise fence bypass attempts, exact smoke exception, v2-only startup, fresh stage/promote/smoke, snapshot capture, and all three rollback boundaries. |

## Risks / Trade-offs

- [Old authority remains reachable] → close writes, stop all replicas, and
  prove every listed legacy state is zero in the same window.
- [A near-match release is accepted] → verify upstream signature when present,
  pin SHA-256 identities separately, self-check all contract domains, and
  independently derive the schema projection.
- [A process quietly issues v1] → deployment admission requires outer v2 true
  on every new process and rejects old catalog configuration.
- [Rollback is falsely considered safe] → distinguish pre-v2 old-stack
  rollback from post-v2 pair-bound compatible-v1 rollback runtime, otherwise demand a
  deliberate destructive restore.

## Migration Plan

### Phase A — v1-active implementation is release-independent

1. While v1 remains active, implement and test only the generic release
   verifier/evidence model, executable fence, current-state audit, protected
   maintenance capability, early configuration snapshot, and rollback record
   machinery. Do not generate a v2 fixture, flip a constant/route, apply
   `0046`, or run v2-only acceptance tests.
2. Obtain independent security/architecture review of this generic code and
   the exact edge, scheduler, Vercel, and Cloudflare configuration plan.

### Phase B — post-release pin gate and live window

1. Wait for the latest post-fix signed release assets. Phase B currently
   expects `0.49.0`, but derives, independently verifies, and reviews all four
   complete evidence records from the actual selected signed release, including
   the raw compatibility artifact and all four raw lock-file hashes. Only then
   make the dedicated post-release commit that generates exact fixtures and
   flips release-specific constants, routes, the `0046` view predicate, and
   v2-only tests. The baseline table above cannot be promoted.
2. Announce the window; enforce the external fence; stop/drain old replicas;
   run the repeatable-read zero-state audit; then capture the database restore
   point and bind its LSN/timestamp to that audit before `0046` or any v2
   mutation.
3. Apply `0046` and deploy only the committed v2 catalog/routes/fixtures with
   outer v2 issuance true on every process.
4. Use the bounded maintenance capability for the exact import → stage →
   bootstrap sequence, then use the sole canary exception for OAuth/MCP smoke,
   exact paired promotion, exception removal, evidence recording, and reopening.
5. On failure retain the fence, consume/remove the maintenance capability, and
   apply the relevant one of the three durable rollback/restoration boundaries.

## Open Questions

None. The exact active release tuple is intentionally deferred until its signed
release assets exist.
