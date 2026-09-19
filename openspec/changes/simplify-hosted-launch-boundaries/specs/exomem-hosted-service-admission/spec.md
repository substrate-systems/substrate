## Purpose

Separate safe hosted runtime activation, customer service authorization and client distribution certification so each can be evaluated without circular prerequisites.

## ADDED Requirements

### Requirement: Runtime activation is independent of artifact certification

An authorized operator SHALL be able to activate exactly one signed runtime candidate per hosted profile without any promoted client artifact. Activation MUST validate an authenticated immutable provisioning target independently of observed customer cells. On an empty fleet it MUST atomically prove the absence of bound cells and conflicting in-flight lifecycle work under the lifecycle/activation fence. When a fleet exists it MUST retain fresh uniformly matching strict v2 fleet verification. A stale or changed target or set MUST reject activation without partial state changes. Activation MUST NOT itself make an unverified cell routable.

#### Scenario: Valid runtime has no certified artifact

- **WHEN** an authorized activation presents a signed candidate and fresh matching fleet evidence while client artifacts are pending or absent
- **THEN** that runtime can become the unique active candidate for its profile
- **AND** no artifact is certified or published as a side effect

#### Scenario: Fleet changes during activation

- **WHEN** a cell binding, runtime identity or lifecycle eligibility changes after evidence collection or conflicts with the candidate
- **THEN** activation fails closed without replacing the active candidate
- **AND** the operator can collect fresh evidence and retry idempotently

### Requirement: Runtime activation terminates preparation authority without destroying evidence

Runtime activation SHALL atomically retire the activated/retired candidates' canary assignments and stages and revoke their entire internal-canary authorization lineage, including unused credentials and in-progress authorization transactions. Becoming live MUST NOT make a former canary eligible again. Activation MUST preserve the exact pending artifact's validated evidence digest and runtime/client provenance independently of the terminated authority, without revoking unrelated ordinary customer grants.

#### Scenario: Canary refresh races runtime activation

- **WHEN** an internal-canary refresh or authorization races candidate activation
- **THEN** any grant committed before activation is revoked by that activation and any attempt after it fails
- **AND** no access token, refresh token, authorization code or unused bootstrap credential survives as usable canary authority

#### Scenario: Preserved artifact is certified after preparation ends

- **WHEN** an exact pending artifact has preserved signed evidence matching its digest and the active runtime after its canary stage is retired
- **THEN** the separate certification operation can validate and certify that artifact without reviving any canary authority
- **AND** an ordinary existing customer's grant remains unaffected

### Requirement: Approved service clients do not require distribution certification

Service-client eligibility SHALL be defined by explicit registration or allowed, bounded and validated client metadata policy, independently of any marketplace or artifact cohort. Client resolution, authorization, invite completion, code exchange, access validation, refresh and contract selection MUST use this separation consistently. Exact redirect, PKCE S256, metadata safety/expiry, consent, audience, scopes, rate limits and revocation MUST remain enforced.

#### Scenario: Eligible owner connects an approved uncertified client

- **WHEN** an eligible owner authorizes an approved client whose distributed artifact has no certification
- **THEN** the normal OAuth flow can issue and refresh a grant bound to the existing owner and tenant
- **AND** absence of certification alone cannot reject any subsequent grant or resource-validation stage

#### Scenario: Unknown client or invalid security binding

- **WHEN** a client is unapproved or supplies invalid metadata, redirect, PKCE, audience or scope
- **THEN** the request fails before granting access even if a runtime is active or some artifact is certified

### Requirement: OAuth continuity is independent of transient cell readiness

Existing eligible owners SHALL authorize and refresh against durable account, ownership, client, grant and entitlement policy without a cell-readiness dependency. Tool execution MUST separately enforce current cell binding, runtime compatibility, readiness and lifecycle policy. Explicit policy denial MUST remain authoritative; temporary infrastructure unavailability MUST NOT revoke a valid token family.

#### Scenario: Cell restarts while a client refreshes

- **WHEN** a valid entitled owner's bound cell is temporarily unavailable and their approved client presents a valid refresh token
- **THEN** token rotation can succeed without a cell request
- **AND** a tool call reports temporary service unavailability without creating another tenant or revoking the family

#### Scenario: Authority is revoked during an outage

- **WHEN** a family is revoked, a client loses approval or account policy denies access while a cell is unavailable
- **THEN** that policy denies the next applicable access/refresh decision
- **AND** cached contracts or prior successful requests do not restore authority

### Requirement: Initial provisioning pins the active runtime atomically

First-time admission SHALL require one approved active runtime target and atomically bind its immutable tuple to the initial lifecycle operation together with the existing invite, entitlement, ownership and capacity transaction. Reconnection of an existing eligible tenant MUST NOT allocate another tenant, cell, volume or initial provisioning operation.

#### Scenario: Runtime activation races first authorization

- **WHEN** the active runtime changes while a first authorization reserves capacity
- **THEN** the completed operation contains one coherent approved target snapshot, or the transaction retries/fails without partial consumption
- **AND** later activation cannot rewrite that operation's target

#### Scenario: Existing owner reconnects repeatedly

- **WHEN** an existing eligible owner reconnects after token expiry or authorizes another approved client
- **THEN** authorization reuses the existing tenant without provisioning side effects

### Requirement: Client artifacts are certified against an active runtime

An authorized certification operation SHALL accept a pending client artifact against an already-active matching runtime when the required exact artifact, client-configuration and genuine host evidence validates. It MUST preserve per-platform evidence requirements, cross-client bindings when claiming paired certification, auditability and idempotency. Certification MUST NOT change runtime activation or service entitlement.

Fresh genuine host evidence gathered through ordinary approved service access SHALL be registrable against the active runtime without an active canary assignment. Operator-authenticated platform lock attachment MUST permit an absent or identical lock on that active runtime while rejecting any change to its immutable runtime identity.

#### Scenario: Pending artifact passes real host acceptance

- **WHEN** exact platform evidence validates a pending artifact against the current matching active runtime
- **THEN** that artifact can become certified without making the runtime pending or requiring another platform to pass

#### Scenario: Second platform is added after runtime activation

- **WHEN** an authorized operator attaches exact signed platform locks and registers genuine host evidence for an approved client against a matching live runtime
- **THEN** the platform's pending artifact can be independently certified without creating a new canary or changing the runtime tuple

#### Scenario: Runtime changes before certification commits

- **WHEN** the evidence's runtime or artifact identity no longer matches at certification commit
- **THEN** certification fails without certifying a different artifact or invalidating existing customer grants

### Requirement: Discovery uses approved runtime contracts without contacting a cell

Authorized MCP initialization and tool listing SHALL use one immutable approved runtime contract independent of artifact certification and transient cell readiness. If no approved runtime contract exists, discovery MUST return a stable temporary service outcome rather than inventing a surface or invalidating the OAuth family.

#### Scenario: Authorized tenant is provisioning

- **WHEN** an eligible client lists tools while its tenant is still provisioning and an approved runtime contract exists
- **THEN** the canonical pinned tool surface is returned without a cell or provider request

#### Scenario: No approved runtime contract exists

- **WHEN** an otherwise-authorized client initializes or lists tools with no approved runtime contract available
- **THEN** discovery returns a stable temporary service outcome without inventing a tool surface
- **AND** the valid OAuth family remains intact

### Requirement: First admission works without a preexisting cell

A verified approved provisioning target SHALL supply every immutable identity required by first admission without reading a bound cell. The same target resolver SHALL govern email-first, OAuth-first and payment-triggered provisioning. Invite consumption, ownership, capacity and operation creation MUST remain atomic and idempotent. Repeated admission MUST return the existing authorized tenant/attempt without consuming another invite or allocating another cell. Removing the last cell MUST NOT remove the approved target. Runtime readiness and actual command serving MUST remain separate from admission.

#### Scenario: Empty installation admits its first owner

- **WHEN** an operator activates a verified target on an empty installation and an eligible owner redeems an ordinary complimentary invite
- **THEN** exactly one tenant, capacity allocation and provision operation are created against that target without reviewer or artifact-certification prerequisites
- **AND** the owner can authenticate and see preparing until actual compatible governance-ready binding permits commands

#### Scenario: Empty routable projection hides conflicting work

- **WHEN** no routable rows exist but a bound cell or nonterminal lifecycle operation with a conflicting target or preparation authority that activation would retire exists
- **THEN** empty-fleet activation refuses atomically without changing selection or consuming customer resources

#### Scenario: Interrupted admission and concurrent first customers

- **WHEN** an admission response is lost or two customers redeem while activation races
- **THEN** retries recover the original committed result and each admitted tenant has one coherent target and one capacity reservation
- **AND** excess demand is refused before payment or provisioning, without weakening the capacity reserve

#### Scenario: Last cell is deleted

- **WHEN** governed deletion removes the last cell while its approved target remains valid
- **THEN** the next eligible customer can provision against that target without recreating a reviewer tenant

#### Scenario: Friend has not completed checkout

- **WHEN** a paid invitation is redeemed before a verified payment entitlement becomes active
- **THEN** no provision operation is queued and no tool use is granted
- **AND** verified webhook replay starts at most one provision and preserves the existing tenant and checkout identity

### Requirement: Target import preserves signed identity

An authenticated target import SHALL validate provenance and the distinct runtime gateway, agent schema and packaging compatibility identities for one immutable release. Reimport SHALL be absent-or-identical. Missing, changed, unsigned or ambiguous target identity MUST block activation without modifying prior candidates or in-flight operations.

Import SHALL select a checked server-side target and verification manifest by candidate ID. The manifest MUST bind verified immutable image and runtime-candidate subjects plus exact source-derived producer/consumer fixtures. The request MUST NOT accept caller-provided target fields or verification assertions. Deployment composition evidence SHALL remain separately checked before live launch; changing infrastructure composition MUST NOT mutate an imported runtime identity.

#### Scenario: New release verification precedes manifest publication

- **WHEN** a release has verified original image and candidate subjects and an exact committed set of consumer fixtures and source pins, but its target manifest has not yet been committed
- **THEN** the generator SHALL produce a schema-2 manifest binding a distinct consumer-pin report and its prerequisite commit without requiring its own output as input
- **AND** deployment and composition SHALL reject that preparatory report and require the full runtime-trust report against a final commit containing the matching target manifest
- **AND** previously reviewed schema-1 manifests SHALL remain supported without fabricated or rewritten evidence

#### Scenario: Operator supplies a replacement target or proof assertion

- **WHEN** a target import includes arbitrary digests, extra target fields or a caller-supplied verification flag
- **THEN** the request is refused without storing a target or changing activation

#### Scenario: Checked target is imported twice

- **WHEN** the checked server-side target and candidate identity are unchanged across two import requests
- **THEN** both requests return the same runtime target digest and the second returns unchanged without rewriting provenance

#### Scenario: Similar packages have different compatibility identities

- **WHEN** two packaging variants expose the same agent profile and schema but different signed compatibility artifacts
- **THEN** activation uses the variant named by the approved release target and rejects substitution of the sibling variant
