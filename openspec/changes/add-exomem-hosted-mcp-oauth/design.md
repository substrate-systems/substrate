## Context

Substrate already has the hard Hosted foundations: invite/magic-link identity, product-scoped browser sessions, provider-neutral entitlements, one-owner/one-tenant constraints, durable lifecycle operations, isolated cell/volume provisioning, private authenticated command forwarding, suspension/deletion, and Home. Exomem now also has an immutable `hosted-alpha-agent-v1` private agent contract and profile-specific cell route.

What is missing is the public product boundary used by Claude and OpenAI plugins. The current browser command gateway is not an MCP server, browser sessions are not OAuth bearer credentials, and exposing the full private cell contract would give chat clients more authority than the alpha needs. The prior personal connector also showed that delegating client token continuity to an upstream identity provider creates reconnection failure modes; Hosted needs to issue and govern its own durable client sessions.

The paired Exomem change `add-hosted-client-plugins` owns the installable packages, automatic-use skills, package identity, and platform promotion. This change owns everything after a client reaches the production MCP resource: standards discovery, authentication, authorization, admission, provisioning state, exact tenant routing, cost controls, and lifecycle enforcement.

The joint acceptance target is:

> A valid invitee installs one plugin, logs into Exomem once, and can use governed long-term memory automatically from a fresh chat. No configuration or Exomem-specific prompting is required.

## Goals / Non-Goals

**Goals:**

- Expose one production Streamable HTTP MCP resource that works with the promoted Claude and OpenAI packages.
- Complete a secure OAuth authorization-code flow through existing Exomem invite/magic-link identity without a separate setup journey or tenant picker.
- Issue Exomem-owned short-lived access tokens and rotating refresh tokens that survive normal client restarts without repeated login.
- Turn the first eligible authorization into exactly one capacity reservation, tenant, entitlement, provisioning operation, isolated cell, and volume.
- Serve deterministic tool discovery before the cell is ready and route calls only through `hosted-alpha-agent-v1` after it is ready.
- Fail closed under provisioning delay, capacity exhaustion, revocation, suspension, deletion, protocol drift, cell mismatch, and concurrency.
- Bound infrastructure and request cost tightly enough for the friends alpha and collect the measurements needed to price a broader release.

**Non-Goals:**

- Hosting client package files or deciding automatic assistant behavior; those belong to the paired Exomem change.
- Exposing the full Home/control-plane command contract, transfer/media/adoption/admin operations, or caller-selected profile membership through MCP.
- Sharing OAuth tokens between Claude and OpenAI, accepting another provider's access token at the MCP resource, or using an upstream IdP token as the durable client session.
- Creating a separate cell per client/device, creating infrastructure on plugin install/discovery, or provisioning an uninvited/unentitled user.
- Public self-service signup or open-ended arbitrary OAuth client registration during the friends alpha.
- Adding a server-side reasoning model or model-worker cost. The initial entitlement keeps cell worker count at zero.

## Decisions

### 1. Substrate is both the OAuth authorization server and MCP resource server

The production resource is one versioned HTTPS Streamable HTTP endpoint derived from `EXOMEM_PUBLIC_BASE_URL` (for example `/api/exomem/mcp/v1`). It returns standards-compliant `401` challenges, OAuth Protected Resource Metadata, and Authorization Server Metadata. Authorization uses the code flow with PKCE S256, exact redirect binding, state preservation, resource indicators/audience binding, and bearer tokens in the `Authorization` header on every MCP request. Tokens in URLs, cookies, tool arguments, or forwarded cell headers are rejected.

Keeping authorization and resource policy in Substrate avoids token exchange or passthrough to a third-party IdP and gives one place to enforce tenant, entitlement, suspension, deletion, and revocation. Reusing the Exomem browser cookie as the MCP credential was rejected because clients need OAuth refresh and audience semantics. Accepting upstream provider tokens was rejected because it couples client continuity to another issuer and recreates the forced-reconnect failure mode.

The resource supports the pinned MCP protocol range and stateless Streamable HTTP request handling. Any MCP session identifier is opaque, short-lived, bound to token family and client, and contains no tenant data; losing it cannot change authorization or create a cell.

### 2. Client admission is narrow but interoperable

Client identity resolution follows the supported MCP mechanisms in priority order: operator-pinned pre-registration and narrowly allowlisted validated HTTPS Client ID Metadata Documents (CIMD). The accepted Claude and OpenAI identities, redirect URIs, and mechanism are release configuration linked to their live promotion evidence. Public clients use `none` authentication and PKCE S256 unless real host evidence requires `private_key_jwt`.

CIMD fetching is HTTPS-only, exact-host allowlisted, SSRF-hardened, response/redirect/size/time bounded, schema validated, exact-client-ID matched, and cache bounded. Generic arbitrary client admission is off for the alpha. Client metadata discovery may create bounded control-plane metadata but can never create an identity, tenant, entitlement, cell, or volume.

Supporting only one guessed mechanism was rejected because native client behavior is an external compatibility contract. Dynamic registration was rejected for alpha because it creates unbounded state and phishing/redirect risk. The real-install gate decides whether a future, separately approved adapter is necessary.

### 3. OAuth login resumes one sealed invite/magic-link transaction

An authorization request creates a short-lived, content-free transaction bound to client, exact redirect URI, resource, requested scopes, PKCE challenge, and opaque browser state. Existing Exomem browser authentication may satisfy identity; otherwise the transaction resumes through the existing email-bound invite redemption or non-enumerating magic-link flow. The browser never chooses a tenant, email override, profile, or cell.

For a new invitee, one database transaction:

1. validates the unconsumed email-bound invite and the authenticated identity;
2. acquires a capacity reservation;
3. consumes the invite;
4. resolves or creates the one Exomem tenant;
5. projects the provider-neutral entitlement and alpha limits;
6. resolves or creates one `initial-provision` lifecycle operation; and
7. authorizes one OAuth grant and one-time code for the client/resource/scopes.

If capacity cannot be reserved, the transaction leaves the invite reusable and creates no session, identity, tenant, entitlement, provisioning operation, OAuth grant, code, cell, or volume. Existing entitled owners skip first-tenant allocation and attach a new client grant to their authoritative tenant.

The authorization code is issued once this durable admission transaction commits; provider provisioning continues asynchronously. Waiting synchronously for a cell was rejected because provider latency would make OAuth callbacks brittle. Consuming the invite before capacity admission was rejected because it could strand a valid user with neither service nor a reusable invite.

### 4. Exomem owns opaque rotating token families

Authorization codes, access tokens, and refresh tokens are high-entropy opaque values stored only as digests. Codes are short-lived, single-use, client/redirect/resource/PKCE bound. Access tokens are short-lived and checked against current grant, tenant, entitlement, and lifecycle state on every request. Refresh tokens are longer-lived, one-time rotating members of a client-specific token family; replay or inconsistent rotation revokes the family. There is no same-exchange retry allowance and no recoverable raw replacement-token cache. Expiry bounds are configuration with secure maximums and are recorded in acceptance evidence.

The initial plugin requests read, write, and offline continuity. `offline_access` is handled at the authorization server and is not advertised as a protected-resource requirement. A scope never selects a tenant or expands the immutable profile. Revoking one client family does not revoke another client unless the user/operator chooses account-wide revocation; suspension or deletion denies every family centrally.

This creates one authorization per client installation without sharing vendor tokens. The second supported client signs in as the same Exomem identity and receives its own family, but resolves the existing tenant and creates no infrastructure.

### 5. Discovery is a pinned control-plane artifact, not a cell request

Substrate imports the exact agent contract emitted by Exomem for `hosted-alpha-agent-v1`. A candidate record contains the profile ID, ordered tool fingerprint, full schema-contract digest, protocol range, command schemas/descriptions/annotations, and source release. `initialize` and `tools/list` are served from the registered live record after bearer authentication; they never wake, health-check, or query a tenant cell.

Only the alpha profile becomes MCP tools. Substrate does not copy an allowlist, rewrite schemas, or derive a broader surface from the full private contract; it adds only its gateway-owned OAuth `securitySchemes` overlay and runtime `_meta['mcp/www_authenticate']`. A new contract enters `pending`; it becomes `live` only after schema validation, exact Exomem package identity agreement, compatible cell deployment, and paired client content tests. Existing live discovery remains in place until promotion is atomic.

Static discovery keeps a just-authorized client connected while its cell provisions and prevents N clients listing tools from causing N cell wakes. Serving tools from whatever cell happens to answer was rejected because it couples discovery to tenant health and permits cross-release drift.

The full private gateway contract is also versioned by release; it is not the same artifact as the alpha agent profile. Before enforcing catalog selection, the exact full-gateway fixture for the current live 0.34.0 agent candidate is generated and reviewed from the same Exomem source commit; the existing 0.24 fixture remains non-routable history because pairing it with the 0.34 agent candidate is not a coherent release unit. Every imported agent candidate names one exact generated full-gateway fixture and semantic digest from the same Exomem source release. Routing selects that catalog entry from the tenant's live or assigned candidate, so the coherent 0.34 live cell and 0.35 rollout cell may coexist. A missing, duplicated, mutable, historical-only, or cross-release catalog entry fails closed before a command or cell request.

### 5a. Pending cohorts are proven through server-selected tenant canaries

A durable operator-only rollout assignment may bind any existing tenant to one exact pending contract under the existing Hosted cohort advisory lock. The assignment records an immutable monotonically increasing tenant generation plus the candidate ID, source release, Hosted runtime protocol, command fingerprint, agent schema digest, compatibility digest, full private-gateway contract digest, state, bounded expiry, and compare-and-swap version. It starts `preparing`, becomes `active` only after the replacement cell reports matching runtime release/protocol/profile/gateway/command/schema identity and the control plane independently resolves compatibility from the immutable candidate, and cannot be retargeted in place. This server-only mechanism lets every routable tenant move to the candidate before promotion. Pending OAuth, clean-client evidence, and marketplace reviewer access remain a narrower authority available only when the assigned tenant is immutable reviewer-purpose. After bearer authentication, MCP discovery and tool routing resolve an active reviewer assignment from the authoritative tenant ID; public headers, URLs, bodies, MCP arguments, cookies, package metadata, and other client-controlled selectors have no authority. Unassigned tenants continue to use the one live cohort. Activating an ordinary tenant is an explicit operator-scheduled maintenance window: its prior live lineage is revoked, it has no pending-client authority, and it remains fail-closed until global promotion and fresh authorization against the now-live client. This deliberately trades brief private-alpha downtime for a smaller auditable authority surface.

An immutable staged client-release declaration breaks the pre-evidence cycle without weakening promotion. For each platform it binds the pending candidate to the exact package, archive, compatibility, schema, plugin version, OAuth configuration, and registered-app identity where applicable, plus operator provenance and bounded expiry. It contains no acceptance result, cannot become live, and cannot satisfy promotion. An operator may register and enable a candidate OAuth client only from this exact declaration and only for reviewer-purpose canary authorization. The operator may mint a short-lived, operator-held `internal_canary` reviewer credential bound to the same assignment generation, candidate, declaration, OAuth client, and tenant so the clean-client run can authenticate; credentials intended for Anthropic or OpenAI reviewers remain unissued and undisclosed until promotion. Issuing the internal credential preserves the existing atomic sealing rule: it revokes the invite-created setup session/transaction graph, after which the clean client signs in with the new credential to create a fresh attributed session. The real clean-client run later creates the existing signed pending artifact, which must match the declaration byte-for-byte; fresh paired evidence remains mandatory for promotion.

Candidate OAuth clients may enter the bounded authorization flow only while their exact candidate has a non-expired staged client declaration, matching internal-canary credential, and preparing or active reviewer-purpose assignment. Authorization completion resolves the authenticated owner through ordinary identity state and may issue a code only when that owner maps to the assigned tenant and the same assignment generation is active. The candidate ID, assignment generation, declaration ID, and exact OAuth client identity are copied durably through the authorization transaction, grant, authorization code, token family, access-token record, and every refresh descendant. Code exchange, access lookup, and refresh accept the lineage only while that exact generation remains active or the exact candidate has become live, and while the declaration remains active or has been atomically marked `evidenced` by the exact matching pending/live signed artifact. Expiry, removal, failure, or retirement before that evidence transition revokes every descendant under the cohort lock; a newer declaration is never inherited. Activating an assignment atomically revokes every existing grant, code, token family, access token, and refresh descendant for that tenant whose client/candidate lineage does not match the assignment, including ordinary live-client families. Removing, expiring, failing, or retiring an assignment atomically revokes its candidate-bound descendants. Promotion retires the assignment without revoking matching descendants because the same candidate is then live.

The reconciler no longer chooses a cell release from the process-wide `EXOMEM_CELL_RELEASE_VERSION` at execution time. Every cell-scoped lifecycle operation snapshots one server-selected target candidate, assignment generation when present, source release, Hosted runtime protocol, runtime contract fields, compatibility, and an independent provisioner wire protocol before its first side effect. For an assigned provision/restore rollout this target comes from the preparing assignment; ordinary provision/restore uses the live cohort; health, export, quiesce, suspend, resume, seal, discard, delete, and other bound-cell work resolves the authoritative candidate/runtime target behind that cell. Context-only export-reference and tenant-destroy provisioner steps use target-free v2 wire bodies while retaining the stored operation protocol and lineage. The snapshot is immutable across leases, waits, retries, restarts, feature-gate changes, and a concurrent cohort promotion. A canary roll is an explicit quiesce/export/restore/rebind sequence: create the preparing assignment, enqueue the restore with the assignment snapshot, keep the old live route authoritative while the replacement is unready, require the provisioner health response to report the exact verified runtime release/protocol/profile/gateway/command/schema identity, resolve compatibility only from the selected candidate catalog, then atomically bind and activate. Missing or mismatched runtime observation leaves the old binding intact or the tenant fail-closed; it never falls through to another release, fixture, or cell. Package/archive/plugin/OAuth locks remain candidate or staged-client authority and never cross the provisioner wire.

Global promotion still requires fresh paired clean-client evidence and the existing routable-set compare-and-swap after every routable tenant reports the candidate. It atomically installs the candidate as live and retires obsolete assignments. Rollback is a forward operation, not demotion: retain the prior immutable image and artifacts, import them as a new pending candidate, create fresh assignment generations, quiesce/export/restore/rebind tenants back one at a time, collect new paired evidence from the restored candidate, and promote it through the normal compare-and-swap. Prior evidence is never reused, a retired candidate is never made live in place, and the currently live cohort remains authoritative for tenants not yet rolled back. Removing or expiring an assignment before its cell is restored revokes its OAuth lineage and fails that tenant closed.

Exposing a candidate query/header, changing the global release environment variable for a canary, reviving a retired row, or signing evidence collected through the live fallback was rejected because those approaches make authority client-selectable, allow retries to drift, bypass release proof, or attest behavior the candidate did not serve.

### 6. Every tool call re-resolves authority and uses the private agent route

For `tools/call`, the gateway validates the bearer token and request bounds, resolves exactly one current identity-to-tenant-to-cell mapping, evaluates the provider-neutral entitlement and scope for the command's canonical read/write classification, verifies desired/lifecycle/readiness/profile compatibility, and forwards to the profile-specific private cell route using only Substrate-created service authentication and trusted routing context.

Public bodies, paths, query strings, cookies, MCP session data, and untrusted headers cannot select tenant, cell, vault, private endpoint, principal, profile, or service credential. The public bearer token is never forwarded. An unavailable, suspended, deleted, mismatched, or stale mapped cell never falls back to the full private route or another tenant. Canonical command errors and idempotency semantics are preserved.

Mutating MCP calls receive a gateway-generated stable idempotency key when the client does not supply a supported request identity. Retries reuse the same tenant/principal/command/canonical-payload namespace. Ambiguous mutations are not replayed under a new key.

### 7. OAuth can finish while provisioning remains explicit

After successful admission, OAuth returns control to the host without waiting for provider readiness. Authenticated initialization and tool discovery work immediately. Content-bearing calls against a non-ready tenant return a stable MCP tool error such as `TENANT_PREPARING`, with a bounded retry interval and opaque request ID; they contain no tenant/cell/provider detail and do not try another cell. Normal clients may retry after the indicated interval.

Capacity exhaustion is decided before authorization grant creation and uses a standards-safe authorization error plus a browser explanation/request reference. Terminal provisioning failure returns a stable supportable MCP error to already-authorized clients. A cell is routable only after private readiness proves exact identity, release, protocol, profile, mutation authority, and worker policy.

Inventing fake empty-memory results during provisioning was rejected because clients could treat absence as truth. Blocking discovery until readiness was rejected because it makes a successful OAuth flow look broken.

### 8. Capacity is a durable multidimensional ledger

The control plane tracks at least storage occupancy, active runtime slots, and in-flight provisioning slots. First admission atomically reserves the configured 5 GiB usable tenant storage allowance plus one active runtime slot before external provider work. The initial entitlement retains the existing 90 MiB upload ceiling and worker count zero even though transfer/media tools are absent from the MCP profile. Provision reconciliation uses one logical operation/provider idempotency identity until exact external state is proven.

Plugin installation, OAuth metadata, client registration, unauthenticated challenge, and contract discovery allocate no tenant infrastructure. Existing-tenant authorization allocates no second slot. Provision claims are globally bounded so invite bursts cannot fan out provider calls. MCP ingress enforces per-IP pre-auth limits and per-account/client post-auth limits for request bytes, response bytes, calls, concurrent calls, and expensive retries. Content is never placed in rate-limit keys or logs.

Suspension denies new calls, stops/quiesces active compute through the lifecycle reconciler, and releases the runtime slot only after the provider confirms the process is inactive. It retains the volume/storage occupancy according to retention policy. Resume must reacquire runtime capacity before starting the same cell. Deletion releases storage capacity only after volume/destruction proof. This reflects real cost: stopped compute and retained storage are distinct resources.

Provisioning every install was rejected as an abuse and cost vector. Keeping suspended processes active was rejected because it spends runtime capacity after access is denied. Releasing storage capacity before verified destruction was rejected because it overcommits disk and can cross tenants.

### 9. Failures are stable, content-free, and retry-safe

OAuth boundary failures use correct HTTP/OAuth status and challenges. Authenticated MCP lifecycle failures use stable codes including preparing, capacity, suspended, deleted, not-ready, incompatible-contract, and provisioning-failed classes with explicit retryability and safe retry timing. Neither responses nor operational telemetry include email, query text, command arguments, titles, paths, excerpts, note content, tokens, codes, client secrets, private endpoints, provider IDs, or billing IDs.

Duplicate callbacks, authorization-code replay, refresh replay, and concurrent first login converge under database uniqueness and transaction isolation. Retries preserve the same admission/provision/idempotency identities. Two-tenant concurrency tests carry content sentinels end to end and require absence from the neighboring response, error, replay record, and log capture.

### 10. One cross-repository acceptance run controls launch

The live run begins with no account for the test email, creates one valid invite, installs one pending platform package, completes one login/authorization, observes exactly one capacity reservation/tenant/entitlement/provision operation/cell/volume, waits through the documented preparing state, and proves unprompted content recall plus governed write and fresh-chat recall. It repeats with the other supported client as the same Exomem identity and requires zero new infrastructure.

The run then proves restart/refresh continuity without repeated login, refresh rotation and replay response, client-family revocation, account suspension/resume, deletion, capacity exhaustion, delayed/terminal provisioning, duplicate callbacks, expired invites, stale discovery, cell mismatch, and concurrent tenant isolation. Each stage records latency, provider operations, resource deltas, MCP calls/bytes, retry counts, and stable error codes against configured acceptance budgets.

The release fails if either client only reaches OAuth, `initialize`, `tools/list`, bootstrap, or metadata. A seeded content-bearing read and a durable write/read-across-fresh-chat are mandatory.

## Risks / Trade-offs

- [Native clients differ in OAuth registration behavior] → Support only pinned pre-registration/CIMD plus bounded DCR where real install evidence requires it; keep generic registration default-off.
- [CIMD or DCR becomes an SSRF/state-growth boundary] → Enforce public HTTPS resolution, redirect and response bounds, schema/identity checks, cache/row TTLs, quotas, and no provisioning authority during registration.
- [OAuth succeeds before the cell is useful] → Keep static discovery available and return a stable preparing result with retry timing until exact readiness passes.
- [Opaque access-token checks add a database read] → Use indexed digest lookup and bounded safe caching while rechecking central lifecycle/revocation policy; prefer immediate revocation over long self-contained token staleness.
- [Refresh-token race logs out a legitimate client] → Make rotation atomic and revoke the family on any replay; no raw replacement token is retained for retry recovery.
- [Contract promotion races cell rollout] → Permit server-only rollout assignments for every tenant, reserve pending OAuth/evidence for reviewer-purpose tenants, snapshot the exact candidate and generation into each lifecycle operation, activate only after exact replacement-cell readiness, and require all routable releases plus both package locks to match before atomic promotion.
- [Automatic client retries amplify cost] → Publish retry timing, coalesce provisioning status, cap concurrent calls/retries, and preserve idempotency.
- [Suspension saves less than expected because volumes remain billed] → Measure compute and storage separately; release runtime slots on verified stop and retain storage honestly until deletion/retention policy permits destruction.
- [Friends usage does not establish market economics] → Record per-tenant calls, bytes, active runtime, storage, provision/support events, and cohort retention without logging content.

## Migration Plan

1. Land the Exomem `hosted-alpha-agent-v1` contract and private route; import its candidate contract into Substrate.
2. Add safe additive migrations: `0025_exomem_mcp_oauth.sql` for OAuth/client/contract state and `0026_exomem_capacity.sql` for capacity reservations, occupancy, and claims. Backfill uncertain existing tenant/provider state as occupied, never free, and make no provider calls in either migration. Queued work retains storage/runtime reservations, while a bounded provision claim is acquired only immediately around provider work. A later additive `0036_exomem_agent_contract_canaries.sql` adds operator-owned rollout assignments for existing tenants, immutable staged client-release declarations and their evidence transition, internal-canary credential bindings, lifecycle target snapshots, and OAuth lineage columns required for staged proof; it creates no assignment, declaration, or credential, changes no live cohort, calls no provider, and revokes no existing token during migration.
3. Add pure protocol, token, client-metadata, admission, capacity, discovery, and error-contract tests before route wiring.
4. Add OAuth metadata/authorize/token/revoke endpoints, then the protected Streamable HTTP MCP route and profile-only forwarding.
5. Add lifecycle capacity reconciliation, runtime release/reacquisition, rate/byte/concurrency limits, telemetry, and runbooks.
6. Deploy behind an alpha flag, register the pending Exomem packages, and run clean real-client acceptance against isolated test tenants.
7. Atomically promote the contract/package identities and expose private install actions to invited friends.

Emergency containment may withdraw candidate client admission and the public MCP route while preserving cells and data, but release rollback follows the forward path defined above: import the retained prior immutable release as a new pending candidate, create fresh rollout generations, restore cells, collect fresh evidence, and promote normally. Token families for withdrawn or mismatched lineages are revoked and new candidate authorizations stop. Existing Home access, tenants, entitlements, vaults, private command routes, and lifecycle reconciliation continue. Any capacity migration remains backward-compatible and can be ignored by the pre-MCP path until a follow-up removal is explicitly designed.

## Open Questions

None. Exact client identifiers/redirects, production origin, token lifetimes within the specified security bounds, rate limits, and acceptance latency budgets are deployment configuration captured and verified in the promotion record; they are not user inputs.
