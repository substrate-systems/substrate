## Context

Exomem Hosted admits an OAuth client through one entry point,
`resolveApprovedOAuthClient` (`src/lib/exomem-hosted/oauth-store.ts:46`), plus five
sibling queries that re-evaluate the same admission predicate at later stages of the
flow (token exchange, refresh, revocation, MCP call, artifact storage). Each of the
six carries the same three-way disjunction: **live cohort**, **reviewer bootstrap
authority**, or **internal canary credential**.

The live-cohort arm is the one real users travel, and it reads:

```sql
client.enabled = true AND EXISTS (
  SELECT 1 FROM exomem_hosted_alpha_cohort AS cohort
  WHERE (client.client_platform = 'claude'
         AND client.oauth_client_config_sha256 = cohort.claude_oauth_client_config_sha256)
     OR (client.client_platform = 'openai'
         AND client.oauth_client_config_sha256 = cohort.openai_oauth_client_config_sha256)
)
```

`exomem_hosted_alpha_cohort` is a view (`migrations/0034:53-80`) that inner-joins one
live `claude` artifact and one live `openai` artifact, so it exposes exactly one
digest per platform. A ChatGPT connector's identity is
`https://chatgpt.com/oauth/<connectorId>/client.json`; `connectorId` differs per
connector, so the document differs, so `oauth_client_config_sha256` differs. Only the
single connector whose digest was pinned at promotion can match. claude.ai escapes
this because it presents one identity for every user on earth.

Constraints inherited from the existing system:

- `exomem_oauth_clients` has a CHECK requiring CIMD rows to carry a metadata digest,
  fetch time, TTL in `[300, 604800]`, expiry, and host (`migrations/0034:36-45`).
- Another CHECK ties `client_platform` and `oauth_client_config_sha256` to be null or
  non-null together, with platform in `('claude','openai')` (`migrations/0034:46-51`).
- `oauthClientConfigSha256` hardcodes `token_endpoint_auth_method: "none"`, so the
  digest is stable regardless of what a document *prefers*. Part 1 (#106) relies on
  this and it is why no digest recomputation is needed here.
- Expired CIMD clients are **disabled, not deleted**: a maintenance statement sets
  `enabled = false` where `metadata_expires_at <= now()` (`oauth-store.ts:608-610`).

## Goals / Non-Goals

**Goals:**

- Any ChatGPT connector, including ones never seen before, can authorize.
- One admission predicate, evaluated identically in all six queries.
- The new unauthenticated write path cannot exhaust operator client capacity, cannot
  be used to enumerate admitted hosts, and cannot touch user or tenant state.
- Pinned-digest admission, reviewer bootstrap, and canary flows behave exactly as
  before.

**Non-Goals:**

- RFC 7591 Dynamic Client Registration (Part 3, for Codex CLI; does not help ChatGPT).
- Proving `consent → code → token`. That hop is still unobserved in production and is
  tracked separately; this change does not claim to fix it.
- Loosening PKCE, redirect-URI validation, SSRF protection, or the `none`
  normalisation.
- Letting an unlisted host in by any route.

## Decisions

### The allowlist is a table, not an environment variable

`EXOMEM_CIMD_ALLOWED_HOSTS` already gates operator registration in TypeScript, and the
obvious move is to reuse it. It does not work here: the predicate is evaluated inside
SQL in six places. Threading an env-derived array through six queries means six
parameter lists that can drift, and it makes the admission rule invisible to anyone
reading the database.

Instead, `exomem_oauth_admitted_cimd_hosts(platform, host)` is server state seeded by
migration. The six predicates each gain one `EXISTS` against it. The env var keeps its
current job — gating *operator* registration — and the table governs *admission*.

The table is keyed by `(platform, host)` rather than host alone because
auto-registration must assign `client_platform`, which the CHECK constraint requires
to be non-null whenever a config digest is present. Deriving platform from the host is
the only signal available at first contact, and putting the mapping in the same row
that grants admission keeps the two from disagreeing.

*Alternative considered:* a hardcoded SQL `IN ('chatgpt.com', ...)` list repeated six
times. Rejected — same drift problem as the env approach, plus it requires a migration
to add a host anyway, without gaining the platform mapping.

### Auto-registration triggers on "not admissible", not "row absent"

The plan called for registering when no client row exists. That is insufficient. Since
expired CIMD clients are disabled rather than deleted, the *second* time a ChatGPT user
connects after their metadata TTL lapses, a row exists, `enabled = false`, and
admission fails — with auto-registration never firing because the row is present.

The trigger is therefore: admission returned nothing, **and** the `client_id` is an
HTTPS URL on an admitted host. Registration is an upsert that revalidates the document
and refreshes digest, fetch time, TTL and `enabled`. This subsumes the absent-row case
and fixes the stale-row case in the same code path.

The upsert must not reuse `registerOperatorOAuthClient`'s conflict clause, which is
gated on an unchanged config digest — precisely the thing that legitimately changes
when a connector's document is reissued. Auto-registration gets its own conflict
target restricted to rows already marked as auto-registered, so it can never overwrite
an operator-managed or bootstrap-pinned client.

### The client population cap is partitioned, not merely raised

The existing `count(*) < 32` bound protects against unbounded client growth. Raising it
alone would let anonymous registrations consume the slots operators need, converting a
storage-bound into an availability incident on the operator control plane.

The cap splits by provenance: auto-registered rows are counted and bounded separately
from operator-managed rows. A full auto-registration partition refuses new anonymous
registrations while leaving operator registration and every already-admitted client
untouched.

### Registration happens inline at `/authorize`, not at a new endpoint

A dedicated registration endpoint would mean an extra round trip that ChatGPT does not
make — it goes straight to `/authorize` with its `client_id`. Registering inline keeps
the client contract unchanged. The cost is that `/authorize` gains a write, which is
why the rate limit and the partitioned cap are part of this change rather than
follow-ups.

## Risks / Trade-offs

**The trust model genuinely weakens.** → We move from "this client is a specific
certified build" to "this client is served by a host we trust". Compensating controls
are unchanged and all still required: redirect URIs validated HTTPS on the document's
own host, PKCE S256, `token_endpoint_auth_method` forced to `none`, SSRF protection on
every fetch, TTL-bounded metadata. The residual exposure is that anyone who can serve
content at an admitted host path can obtain a client registration — which is the
standard CIMD model, and the reason the allowlist stays operator-curated and small.

**Unauthenticated write at `/authorize`.** → Per-address rate limit following the
existing `EXOMEM_RATE_LIMITS.oauthAuthorizeClient` pattern, a hard partition cap, and
no user/tenant/invite/grant state touched on this path. Failures are uniform so the
endpoint does not reveal which hosts are admitted.

**Outbound fetch driven by an unauthenticated caller.** → Only ever to an allowlisted
host, through the existing `isCimdNetworkAddressAllowed` guard, with the existing fetch
bounds. The allowlist is checked *before* any network call, so an unlisted host costs
one string comparison.

**Six predicates must stay identical.** → They already must, and already do by
convention. This change adds one clause to each. A test that asserts a client admitted
at `/authorize` is also admitted at token exchange, refresh and MCP call is the guard
against drift; a shared SQL fragment is the alternative but the queries differ enough
in aliasing that extraction risks being wrong in a subtler way.

**A promotion is still required for anything to work.** → Host-allowlisted admission
requires a live cohort for the platform, and no cohort exists until a promotion
succeeds. This change makes ChatGPT *admissible*; it does not make Exomem Hosted live.
Sequencing matters: this must not be mistaken for a launch.

## Migration Plan

1. `migrations/0048_exomem_oauth_admitted_cimd_hosts.sql` creates the table, seeds it
   with the hosts currently in `EXOMEM_CIMD_ALLOWED_HOSTS` and their platforms, and
   adjusts the client population bound.
2. Deploy is additive: the new predicate arm is a disjunction, so every currently
   admissible client stays admissible. No client rows are rewritten.
3. Rollback is deleting the table's rows — with an empty allowlist the new arm matches
   nothing and behavior returns exactly to pinned-digest admission. The migration is
   therefore safe to leave in place during a revert of the application code.

## Open Questions

- Whether a connector's `connectorId` is stable per user or per install determines how
  many auto-registered rows accumulate per real person, and therefore how large the
  auto-registration partition should be. The plan flagged this as testable by deleting
  and re-adding a connector and comparing `client_id`; it has not been run, so the
  initial bound is a guess and should be revisited once real connectors exist.
- Whether expired auto-registered rows should be garbage-collected rather than left
  disabled forever. Not required for correctness here, but the partition fills with
  tombstones otherwise.
