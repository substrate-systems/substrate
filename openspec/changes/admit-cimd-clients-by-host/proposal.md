## Why

No ChatGPT user other than the operator can connect to Exomem Hosted, and no
change to the promotion process can fix that. Live-cohort admission compares a
client's `oauth_client_config_sha256` against a **single** digest per platform
carried on the `exomem_hosted_alpha_cohort` view. Every ChatGPT connector has its
own `connectorId`, therefore its own `client.json`, therefore its own digest — so
at most one ChatGPT connector on earth can ever be admitted. claude.ai is unaffected
only because claude.ai presents one global identity for all users.

This is the launch blocker for the friends alpha. Kim, Yusuke, Olivia and Ash can
be invited today and Claude will work for all four; any of them reaching for
ChatGPT gets a bare `invalid_request` with no explanation. It is also why two
promotion windows failed: the gate demanding OpenAI clean-client evidence was
correctly refusing to certify an integration that genuinely does not work.

The neighbouring half of this problem is already solved. #106 widened CIMD document
validation to accept a document that advertises `none` among its supported token
endpoint auth methods, and on 2026-08-16 ChatGPT's client was admitted at
`/authorize` in production for the first time (`303`, consent page rendered). What
remains is admission for connectors we have never seen before.

## What Changes

- Unknown CIMD clients whose host is allowlisted are **auto-registered on first
  authorization** instead of being rejected for having no client row.
- Live-cohort admission gains an alternative to the pinned-digest comparison:
  a CIMD client on an admitted host is admitted while its metadata is unexpired
  and a live cohort exists for its platform.
- The admitted-host allowlist becomes **server state** (`exomem_oauth_admitted_cimd_hosts`)
  rather than environment configuration, because the admission predicate is
  evaluated in SQL in six separate queries.
- The `exomem_oauth_clients` population cap is raised **and split**, so
  auto-registered clients cannot exhaust the slots operator-managed clients need.
- `/authorize` gains a per-IP rate limit covering the new unauthenticated write.

**This is a widening of a security predicate and should be reviewed as one.** It
trades *"the client is a specific certified build"* for *"the client is served by a
trusted host"*. It is deliberately narrower than the generic arbitrary client
admission the existing spec forbids during the alpha: an unlisted host is still
refused, and everything else holds unchanged — redirect URIs still validated HTTPS
on the document's own host, PKCE S256 still required, `token_endpoint_auth_method`
still normalised to `none`, SSRF protection still applied on every metadata fetch.

Not in scope: RFC 7591 Dynamic Client Registration. That is what Codex CLI asks for
by name, it is independent of this work, and it does **not** help ChatGPT.

## Capabilities

### New Capabilities
<!-- none: this extends an existing admission capability rather than introducing one -->

### Modified Capabilities
- `exomem-hosted-mcp-oauth`: `OAuth Authorization Is Client-Bound And Exomem-Owned`
  currently admits a validated CIMD document only when it also matches a promoted
  artifact's pinned configuration digest. It gains host-allowlisted admission and
  first-authorization auto-registration, while continuing to forbid generic
  arbitrary client admission.

## Impact

- `migrations/0048_exomem_oauth_admitted_cimd_hosts.sql` — new table, seeded with
  the hosts already trusted via `EXOMEM_CIMD_ALLOWED_HOSTS`; raised and split
  client population cap.
- `src/lib/exomem-hosted/oauth-store.ts` — the live-cohort branch of six admission
  predicates (`resolveApprovedOAuthClient` and five siblings).
- `src/lib/exomem-hosted/oauth-client-admission.ts` — auto-registration entry point,
  reusing `fetchCimdMetadata`, `normalizeOperatorOAuthClientRegistration` and
  `isCimdNetworkAddressAllowed` unchanged.
- `src/app/api/exomem/oauth/authorize/route.ts` — registration-on-miss and its rate limit.
- Unblocks: any ChatGPT connector, and any future client identifying by CIMD on an
  admitted host. Does not by itself complete a promotion — the OAuth round trip past
  consent (`consent → code → token`) remains unproven; `exomem_oauth_access_tokens`
  has never held a row.
