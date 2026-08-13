## ADDED Requirements

### Requirement: The cold cut uses only a re-derived verified release tuple

The system SHALL not make the rejected 0.48.0 baseline an active cut target.
After the latest signed post-fix upstream release assets exist, it SHALL verify
their actual signature mechanism where provided, record SHA-256 integrity
identifiers separately, and independently derive/pin four complete records: runtime
(source/image/private gateway/agent runtime/command), provisioner
(source/image/outer wire/runtime identity), composition
(Git/forward-contract/lock-pair bytes/schema version/deployed manifest), and
clients (Claude/OpenAI package/archive/plugin/registered-app/configuration).
The client/composition payload SHALL carry the raw compatibility-artifact hash
and all four raw lock-file hashes separately (Claude package/archive and OpenAI
package/archive).
Schema and compatibility digests SHALL come from verified upstream
schema/compatibility artifacts, not a runtime health response. It SHALL verify
exact runtime self-digests before deriving a deterministic,
release-independent gateway schema projection. Phase A SHALL remain v1-active
and implement only generic verifier/fence/audit/maintenance-capability support;
it SHALL not create v2 fixtures, flip release-specific constants/routes, apply
`0046`, or run v2-only acceptance. Only the reviewed post-release pin commit
MAY make those release-specific changes.

#### Scenario: A selected signed release is verified
- **WHEN** the operator supplies the latest post-fix signed release selected in Phase B (currently expected to be `0.49.0`) and its assets
- **THEN** signature verification is recorded only for artifacts with a verified cryptographic signature
- **AND** SHA-256 verification is recorded as integrity verification
- **AND** the active tuple and independent schema projection are pinned before catalog mutation

#### Scenario: A release identity is incomplete or conflated
- **WHEN** a required digest/provenance is missing, a private gateway digest is used as the agent runtime digest, projection is nondeterministic, or the forbidden `18325eebae09e2e974af3837ca120ddbe829a05e05a67454623613b7f49c09c0` value appears
- **THEN** verification fails before any catalog, assignment, OAuth, client, or cohort mutation

#### Scenario: Phase A has no release-specific cut
- **WHEN** the post-fix release evidence is not completely verified and pinned
- **THEN** v1 remains active
- **AND** no v2 fixture, route/constant flip, `0046` migration, or v2-only acceptance is introduced

### Requirement: Maintenance fencing is externally executable and proves the old cohort absent

The system SHALL enforce an edge/WAF denial for `/api/exomem/**`, disable Hosted
scheduler ingress, protect old Vercel deployment URLs or rotate their old
database/provisioner/Cloudflare Access credentials, and deploy
`EXOMEM_HOSTED_COLD_CUT_MAINTENANCE=true` before replacement. The advisory
transaction lock SHALL serialize only one operator mutation; it SHALL not be
treated as the maintenance fence. In one repeatable-read snapshot after old
replicas drain, the system SHALL prove the exact current-state zero predicates
for non-final operations, non-deleted cells/exports, current assignments and
transfer grants, current reviewer authority, and enabled/reachable v1 OAuth and
client lineage. Terminal, deleted, revoked, expired, consumed, and retired
history SHALL be allowed. It SHALL not clean up or recover old state implicitly.

#### Scenario: Old authority is still reachable
- **WHEN** any old replica remains reachable or any required zero-state count is non-zero
- **THEN** the cut aborts with the public-write/admission fence still held
- **AND** no catalog migration, v2 issuance, or fresh authority creation occurs

#### Scenario: A public route bypasses the database lock
- **WHEN** an external caller reaches an old deployment URL or `/api/exomem/**` while maintenance is active
- **THEN** edge/app fencing rejects it before a Hosted mutation
- **AND** only the exact reviewer-canary exception may proceed

### Requirement: One process-global v2 cohort replaces the hard-coded view

The system SHALL preserve migrations `0031` and `0032` as immutable history.
After the empty-old-cohort proof, only new `0046` SHALL replace the latest
`0034` `exomem_hosted_alpha_cohort` view identically except for its exact v2
profile predicate. The replacement `0046` migration SHALL
not contain the rejected lifecycle-profile/backfill design:
`target_agent_profile`, lifecycle backfill/defaults, dual-live coexistence,
global promotion CAS, rolling absent/false issuance, or cross-profile
descendant behavior. Every new process SHALL load only the verified v2 catalog,
routes, and fixtures, and shall enable the outer v2 issuance path.

#### Scenario: A process has old or disabled issuance configuration
- **WHEN** any new process has missing, false, malformed, or non-v2 outer issuance configuration, or an old catalog/route fixture
- **THEN** deployment admission fails closed
- **AND** no public-write fence is released

### Requirement: Reviewer and client authority is fresh and v2-only

The system SHALL provide one protected, bounded maintenance capability after
the post-release tuple is verified. It SHALL bind that exact tuple and raw
artifact payload, revalidate them under the advisory transaction lock for each
step, permit only pending candidate import then fresh Claude/OpenAI staging then
fresh reviewer bootstrap, consume on success, and revoke/remove on abort. It
SHALL not promote, issue ordinary work, mint general OAuth, route a request, or
touch legacy state.

The system SHALL create reviewer bootstrap, staged clients, OAuth transactions,
grants, token families, install actions, and promotion evidence exclusively
from the verified active tuple after the cut. It SHALL not reuse or upgrade old
authority. Reopening requires fresh clean-client stage/promotion and an
authenticated provision/bind/ready/client smoke. The promotion sequence SHALL
be: verify the full raw artifact payload; import pending candidate; stage both
clients; bootstrap reviewer; record one-window OAuth/MCP smoke evidence; in one
locked transaction promote candidate then paired client artifacts then retire
consumed stage/assignment rows; and remove the exception.

#### Scenario: An old client lineage is supplied to bootstrap or promote
- **WHEN** any old reviewer, OAuth, client, artifact, or promotion lineage is supplied
- **THEN** the operation fails without mutation
- **AND** the maintenance fence remains held

#### Scenario: The sole reviewer-canary smoke exception is used
- **WHEN** the exact fresh reviewer bootstrap authority, staged client, canonical resource, one-window OAuth transaction, and newly minted MCP bearer match
- **THEN** only that OAuth completion/token lineage and MCP bearer smoke may proceed during maintenance
- **AND** refresh, old bearer, general OAuth, public writes, and caller-selected routes remain denied

#### Scenario: Maintenance capability cannot be reused or expanded
- **WHEN** its tuple differs, a step is out of order, promotion/general issuance is requested, or the cut aborts
- **THEN** the capability performs no mutation and is consumed or removed as applicable

### Requirement: Rollback claims follow the work boundary

The system SHALL capture immutable configuration/deployment/credential and old
0.39 evidence before the fence. It SHALL capture a database restore point only
after external fences/drain and the zero audit succeed, before `0046` or v2
mutation, and bind its LSN and timestamp to that audit snapshot. Before first v2 work,
the operator MAY restore the previously verified old 0.39 stack. After any v2
work, rollback SHALL use only a pair-bound, proven-compatible v1 rollback
runtime and a newly proven client cohort. If that proof is absent, the system SHALL
require an explicit operator-approved destructive restore with an acknowledged
loss boundary; it SHALL not claim old 0.39 compatibility.

#### Scenario: Post-v2 rollback lacks pair-bound proof
- **WHEN** v2 work exists and the compatible v1 rollback pair or newly proven client cohort is absent
- **THEN** rollback is refused
- **AND** the operator receives the explicit destructive-restore path rather than an unproven compatibility claim
