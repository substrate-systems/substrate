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

The production resource is one HTTPS Streamable HTTP endpoint derived from `EXOMEM_PUBLIC_BASE_URL` (for example `/api/exomem/mcp`). It returns standards-compliant `401` challenges, OAuth Protected Resource Metadata, and Authorization Server Metadata. Authorization uses the code flow with PKCE S256, exact redirect binding, state preservation, resource indicators/audience binding, and bearer tokens in the `Authorization` header on every MCP request. Tokens in URLs, cookies, tool arguments, or forwarded cell headers are rejected.

Keeping authorization and resource policy in Substrate avoids token exchange or passthrough to a third-party IdP and gives one place to enforce tenant, entitlement, suspension, deletion, and revocation. Reusing the Exomem browser cookie as the MCP credential was rejected because clients need OAuth refresh and audience semantics. Accepting upstream provider tokens was rejected because it couples client continuity to another issuer and recreates the forced-reconnect failure mode.

The resource supports the pinned MCP protocol range and stateless Streamable HTTP request handling. Any MCP session identifier is opaque, short-lived, bound to token family and client, and contains no tenant data; losing it cannot change authorization or create a cell.

### 2. Client admission is narrow but interoperable

Client identity resolution follows the supported MCP mechanisms in priority order: operator-pinned pre-registration, validated HTTPS Client ID Metadata Documents (CIMD), and a bounded Dynamic Client Registration compatibility adapter only for a promoted host that demonstrably requires it. The accepted Claude and OpenAI identities, redirect URIs, and mechanism are release configuration linked to their live promotion evidence.

CIMD fetching is HTTPS-only, SSRF-hardened, response/redirect/size/time bounded, schema validated, exact-client-ID matched, and cache bounded. Dynamic registrations, when enabled, have strict origin/redirect policy, quotas, expiry, and no entitlement or infrastructure effect. Generic arbitrary client admission is default-off for the alpha. Client registration or metadata discovery may create bounded control-plane metadata but can never create an identity, tenant, entitlement, cell, or volume.

Supporting only one guessed mechanism was rejected because native client behavior is an external compatibility contract. Open unauthenticated DCR was rejected because it creates unbounded state and phishing/redirect risk. The real-install gate decides which narrowly enabled adapters remain necessary.

### 3. OAuth login resumes one sealed invite/magic-link transaction

An authorization request creates a short-lived, content-free transaction bound to client, exact redirect URI, resource, requested scopes, PKCE challenge, and opaque browser state. Existing Exomem browser authentication may satisfy identity; otherwise the transaction resumes after the existing email-bound invite redemption or non-enumerating magic-link flow. The browser never chooses a tenant, email override, profile, or cell.

For a new invitee, one database transaction:

1. validates the unconsumed email-bound invite and the authenticated identity;
2. acquires a capacity reservation;
3. consumes the invite;
4. resolves or creates the one Exomem tenant;
5. projects the provider-neutral entitlement and alpha limits;
6. resolves or creates one `initial-provision` lifecycle operation; and
7. authorizes one OAuth grant for the client/resource/scopes.

If capacity cannot be reserved, the transaction leaves the invite reusable and creates no tenant, entitlement, provisioning operation, OAuth grant, cell, or volume. An identity established by email authentication may remain, but it has no Exomem routing authority. Existing entitled owners skip first-tenant allocation and attach the new client grant to their authoritative tenant.

The authorization code is issued once this durable admission transaction commits; provider provisioning continues asynchronously. Waiting synchronously for a cell was rejected because provider latency would make OAuth callbacks brittle. Consuming the invite before capacity admission was rejected because it could strand a valid user with neither service nor a reusable invite.

### 4. Exomem owns opaque rotating token families

Authorization codes, access tokens, and refresh tokens are high-entropy opaque values stored only as digests. Codes are short-lived, single-use, client/redirect/resource/PKCE bound. Access tokens are short-lived and checked against current grant, tenant, entitlement, and lifecycle state on every request. Refresh tokens are longer-lived, one-time rotating members of a client-specific token family; replay or inconsistent rotation revokes the family. Expiry bounds are configuration with secure maximums and are recorded in acceptance evidence.

The initial plugin requests read, write, and offline continuity. `offline_access` is handled at the authorization server and is not advertised as a protected-resource requirement. A scope never selects a tenant or expands the immutable profile. Revoking one client family does not revoke another client unless the user/operator chooses account-wide revocation; suspension or deletion denies every family centrally.

This creates one authorization per client installation without sharing vendor tokens. The second supported client signs in as the same Exomem identity and receives its own family, but resolves the existing tenant and creates no infrastructure.

### 5. Discovery is a pinned control-plane artifact, not a cell request

Substrate imports the exact agent contract emitted by Exomem for `hosted-alpha-agent-v1`. A candidate record contains the profile ID, ordered tool fingerprint, full schema-contract digest, protocol range, command schemas/descriptions/annotations, and source release. `initialize` and `tools/list` are served from the registered live record after bearer authentication; they never wake, health-check, or query a tenant cell.

Only the alpha profile becomes MCP tools. Substrate does not copy an allowlist, rewrite schemas, or derive a broader surface from the full private contract. A new contract enters `pending`; it becomes `live` only after schema validation, exact Exomem package identity agreement, compatible cell deployment, and paired client content tests. Existing live discovery remains in place until promotion is atomic.

Static discovery keeps a just-authorized client connected while its cell provisions and prevents N clients listing tools from causing N cell wakes. Serving tools from whatever cell happens to answer was rejected because it couples discovery to tenant health and permits cross-release drift.

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
- [Refresh-token race logs out a legitimate client] → Make rotation atomic, allow only the narrowly documented retry race if the client contract requires it, and revoke on confirmed replay.
- [Contract promotion races cell rollout] → Keep pending/live records atomic and require all routable releases plus both package locks to match before promotion.
- [Automatic client retries amplify cost] → Publish retry timing, coalesce provisioning status, cap concurrent calls/retries, and preserve idempotency.
- [Suspension saves less than expected because volumes remain billed] → Measure compute and storage separately; release runtime slots on verified stop and retain storage honestly until deletion/retention policy permits destruction.
- [Friends usage does not establish market economics] → Record per-tenant calls, bytes, active runtime, storage, provision/support events, and cohort retention without logging content.

## Migration Plan

1. Land the Exomem `hosted-alpha-agent-v1` contract and private route; import its candidate contract into Substrate.
2. Add database migrations for OAuth transactions/grants/token families and capacity reservations/occupancy with all new public paths disabled.
3. Add pure protocol, token, client-metadata, admission, capacity, discovery, and error-contract tests before route wiring.
4. Add OAuth metadata/authorize/token/revoke endpoints, then the protected Streamable HTTP MCP route and profile-only forwarding.
5. Add lifecycle capacity reconciliation, runtime release/reacquisition, rate/byte/concurrency limits, telemetry, and runbooks.
6. Deploy behind an alpha flag, register the pending Exomem packages, and run clean real-client acceptance against isolated test tenants.
7. Atomically promote the contract/package identities and expose private install actions to invited friends.

Rollback withdraws client admission and the public MCP route or restores the previous live contract record. Token families are revoked, new authorizations stop, and cells are not deleted. Existing Home access, tenants, entitlements, vaults, private command routes, and lifecycle reconciliation continue. Any capacity migration remains backward-compatible and can be ignored by the pre-MCP path until a follow-up removal is explicitly designed.

## Open Questions

None. Exact client identifiers/redirects, production origin, token lifetimes within the specified security bounds, rate limits, and acceptance latency budgets are deployment configuration captured and verified in the promotion record; they are not user inputs.
