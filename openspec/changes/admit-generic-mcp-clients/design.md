## Context

Three facts, each verified against the code rather than assumed.

**Admission is platform-shaped all the way down.** Nine predicates in
`oauth-store.ts` share one clause requiring a live cohort row whose `platform`
equals the client's own. `exomem_hosted_alpha_platform_cohort` produces such a
row only by joining a `live` `exomem_client_artifacts` record to the live
candidate on package, archive, compatibility, contract and plugin locks. So
admission ultimately asks: *is this client a certified build of a platform we
promoted?*

**Certification is a distribution artefact.** `exomem_client_artifacts` carries
`install_url`, `plugin_version` and, for OpenAI, `registered_app_id_sha256`;
production carries `EXOMEM_HOSTED_CLAUDE_INSTALL_URL` and
`EXOMEM_HOSTED_OPENAI_INSTALL_URL`. The clean-client evidence run attests
install, authorization, tool discovery, recall, citation, durable capture and
fresh-chat recall — the journey a marketplace requires before listing. It is
proof for a directory, not proof of safety for a tenant.

**Tenancy is already gated elsewhere, and not by the client.** A first-time
identity reaches a tenant only through `admitFirstOAuthInviteAtomic`, which
consumes an operator-minted invite atomically; an existing owner reaches theirs
through `attachExistingOwnerAuthorizationAtomic`, which refuses to detach or
re-point an existing grant. Neither consults a certified artifact for the
*authority to have a tenant*; the artifact only decides which client software may
ask.

Those three together are the whole argument: for a client nobody distributes,
the certification gate cannot be satisfied and was never the thing protecting
anything.

## Goals / Non-Goals

**Goals:**

- Any MCP-capable client can obtain a grant to a tenant its user is already
  entitled to, without an operator action per client type.
- The certified lane is untouched, byte-for-byte, in both behaviour and risk.
- The generic lane is off until deliberately enabled, and withdrawable in one
  operator action without touching the other lanes.
- A generic client's registration cannot exhaust operator or CIMD client
  capacity, and cannot rewrite a client belonging to either.

**Non-Goals:**

- Any new path to tenancy. If this change makes it possible for someone without
  an invite to reach a tenant, it has failed regardless of what else it achieves.
- Certifying generic clients. There is nothing to certify.
- Removing `client_platform`. Certified clients still need it; it becomes
  optional for the one mode that has no platform.

## Decisions

### 1. The invite is the gate, not the client

**Chosen.** A generic client may register freely and may ask for authorization
freely. It reaches a tenant only where an invite or an existing ownership already
says that identity may. Registration proves nothing about a person and is not
asked to.

*Rejected — host allowlist for generic clients.* Extends the CIMD model to a
third class, and fails the actual case: Codex CLI, Zed and a hand-written agent
run locally and are served from no host. It would admit exactly the clients that
are already easiest to admit and exclude the ones this change exists for.

*Rejected — operator pre-registration per client type.* Tightest control, but it
is today's situation minus the artifact requirement. "Any MCP-capable agent" with
an operator in the loop for each one is not any agent, and the per-client
ceremony is the cost this change is meant to remove.

The security posture, stated plainly: **this trades "the client is a certified
build of a promoted platform" for "the client is irrelevant; the person holds an
invite."** PKCE S256, exact redirect-URI binding, https-only redirects, SSRF
protection on any metadata fetch, single-use short-lived codes, resource/audience
binding and explicit scopes are all unchanged and all still apply. What is
genuinely given up is the ability to say which software touched a tenant's
memory, and that must be reviewed as a real widening rather than waved through.

### 2. Generic clients carry no platform and require no cohort

A generic client sets `admission_mode = 'generic'` and leaves `client_platform`
NULL. The nine predicates gain an arm that admits such a client without
consulting `exomem_hosted_alpha_platform_cohort` at all.

This is deliberate and is the point of the change: requiring *any* cohort would
reintroduce the coupling, because a cohort exists only where a certified artifact
does. The live **contract candidate** still governs what the gateway exposes, so
a generic client is never talking to an unpromoted contract — it simply is not
asked to be a certified consumer of one.

The arm must be added by a single deterministic transform across all nine sites,
as `admit-cimd-clients-by-host` established, because a missed site fails late and
reads as an intermittent client bug. The cross-stage drift test added in #129
already covers exactly this failure and must be extended to the generic lane.

### 3. The lane is disabled by default

Admission consults server state, not only an environment variable, so that the
predicates themselves can express it and one operator action withdraws it
everywhere at once — the same reasoning that put the CIMD host allowlist in a
table rather than in env. `registration_endpoint` is advertised only while the
lane is enabled, so a disabled lane is not discoverable.

The friends alpha therefore proceeds unchanged whether or not this has landed.

### 4. Registration is bounded like the CIMD lane, in its own partition

`exomem_oauth_client_partition_available` already partitions the population bound
by provenance (128 auto-registered, 32 operator). Generic registrations take a
third partition. An unauthenticated flood must degrade into "no more generic
clients" and never into "no more operator control" or "no more connectors".

Registration is rate limited per address following
`EXOMEM_RATE_LIMITS.oauthAuthorizeClient`, and every failure returns one
indistinguishable response so the endpoint cannot be used to enumerate anything.

### 5. Redirect rules follow the self-registered precedent

A generic client is vouched for by nobody, so its redirects get the stricter of
the two existing rules rather than the operator one: https with no credentials
and no fragment, bounded length, plus loopback `http://127.0.0.1` and
`http://[::1]` for local CLI agents, which is the one case
`isSameHostHttpsRedirect` cannot serve because there is no serving host.
Loopback-only http is already precedented by `isSafeLoopbackOAuthRedirect`.

## Risks / Trade-offs

- **Attribution is lost.** Once any client may connect, "which software wrote
  this memory" is no longer answerable from admission state. If that matters
  later it needs its own mechanism; this change should not pretend to provide
  one.
- **A hostile client is now in scope.** Previously a malicious client had to be a
  certified build; now it needs only a victim who holds an invite and can be
  talked into authorizing. The consent screen becomes the load-bearing surface it
  was always nominally meant to be, and should name the client and scopes
  plainly. Worth a follow-up review of `consent-audience.ts` against this.
- **Registration is an unauthenticated write.** Bounded by partition and rate
  limit, but it is a new anonymous path into a table that admission reads, which
  is the same class of exposure `admit-cimd-clients-by-host` introduced and
  should be reviewed with the same seriousness.
- **Nine predicates become ten arms each.** Every additional disjunct raises the
  cost of a missed site. Mitigated by the deterministic transform and by
  extending the cross-stage test, not by care.
- **Reverses a stated alpha constraint.** The prior decision was correct for its
  moment. Shipping disabled by default means the reversal is recorded in the spec
  without being imposed on the alpha in flight.
