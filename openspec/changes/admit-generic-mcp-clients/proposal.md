## Why

Exomem's premise is memory that lives inside whichever assistant someone already
uses. Today exactly two client types can ever reach a tenant, and that is
structural rather than a configuration gap:

- `client_platform` is `CHECK (... IN ('claude', 'openai'))` in five migrations.
- `exomem_hosted_alpha_platform_cohort` is a literal two-branch `UNION ALL`.
- Every admission predicate requires `cohort.platform = client.client_platform`,
  including the host-allowlist branch added by `admit-cimd-clients-by-host`.
- A cohort row requires a **live client artifact**: a staged release carrying
  package, archive, compatibility and contract locks, plus a signed clean-client
  evidence run.

That model fits a distributed, certified build. Claude and ChatGPT are directory
listings — a user clicks "add Exomem" inside them, and the marketplaces require
an attested install-to-recall journey before they will list it. The artifact,
the evidence and the promotion all exist to satisfy that.

A generic MCP client is not distributed by anyone. Codex, Zed, Cursor or
something hand-written is pointed at the endpoint by the person using it. There
is no package, no listing, and nothing for an artifact to be *about* — so such a
client can never hold one, can never have a cohort, and can never be admitted.

The cost also compounds. `scope-cohort-admission-per-platform` established that
promotion is one-shot per candidate, so adding a third platform under today's
model would mean a fresh candidate and a fresh clean-client evidence run for
Claude and ChatGPT as well. Every new client type would re-certify every existing
one.

The decisive observation is that certification is not what protects a tenant.
**Who** may reach one is already gated by an operator-minted invite
(`admitFirstOAuthInviteAtomic` for a new owner,
`attachExistingOwnerAuthorizationAtomic` for an existing one), entirely
independently of **what software** is asking. Someone holding Zed and no invite
gets nothing today and would still get nothing. One invited person connecting
Claude, ChatGPT, Codex and Zed to a single tenant is the product working.

This change reverses a deliberate prior decision. The current requirement says
"generic arbitrary client admission MUST remain disabled during the friends
alpha", and that was right when the only proven admission signal was a pinned
digest. It is now the constraint standing between the product and its own
premise, so it is replaced rather than quietly widened — and, because the friends
alpha is imminent, the new lane ships disabled by default so enabling it is a
separate, deliberate act.

## What Changes

- Add a third client admission class: a **generic MCP client**, admitted on the
  strength of dynamic registration and a valid invite rather than a promoted
  artifact. It carries no platform, no configuration digest, and no cohort
  requirement.
- Add an RFC 7591 dynamic client registration endpoint, advertised as
  `registration_endpoint` in authorization server metadata only while the lane is
  enabled.
- **BREAKING (spec-level):** replace the requirement that generic client
  admission remain disabled with one that governs how it is admitted, bounded and
  disabled.
- Decouple admission from the two-platform enum, so `client_platform` becomes
  optional rather than a universal precondition, without loosening either
  existing lane.
- Keep pinned-digest and host-allowlist admission byte-identical in behaviour.
  Certified clients continue to require a live cohort for their own platform.
- Ship behind an explicit enablement so the friends alpha is unaffected until the
  operator decides otherwise.

## Capabilities

### New Capabilities

None. This extends the existing OAuth admission capability rather than adding a
new surface.

### Modified Capabilities

- `exomem-hosted-mcp-oauth`: replace the blanket prohibition on generic client
  admission with a bounded generic lane; add dynamic client registration, its
  population bound and rate limit, and the rule that a generic client's grant is
  gated by invite rather than by artifact.

## Impact

- `migrations/0050_*`: a `generic` admission mode, `client_platform` permitted to
  be NULL for that mode alone, and a third provenance partition in the client
  population bound.
- `src/lib/exomem-hosted/oauth-store.ts`: the nine admission predicates gain a
  generic arm; `src/lib/exomem-hosted/oauth-client-admission.ts` gains the
  registration request validator.
- `src/app/api/exomem/oauth/register/route.ts`: new unauthenticated, rate-limited
  registration endpoint.
- `src/app/api/exomem/oauth/authorize/route.ts` and the metadata routes: generic
  clients resolve, and `registration_endpoint` is advertised conditionally.
- `docs/runbooks/exomem-hosted-alpha.md`: how to enable the lane, what it widens,
  and how to withdraw it.

## Non-goals

- Loosening who may reach a tenant. The invite remains the only admission to
  tenancy, and this change must not create a second path to one.
- Listing Exomem in any further directory. A new marketplace listing would still
  need its own certified artifact and evidence run; this lane is for clients
  nobody distributes.
- Replacing the certified lane. Claude and ChatGPT keep pinned-digest and
  host-allowlist admission exactly as they are, because their marketplaces
  require the attestation those produce.
