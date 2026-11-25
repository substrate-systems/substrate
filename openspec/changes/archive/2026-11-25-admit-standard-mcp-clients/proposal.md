## Why

Two mainstream MCP clients cannot connect today:

- **Google Antigravity** identifies by an OAuth Client ID Metadata Document at
  `https://antigravity.google/oauth/client-metadata.json`. The CIMD path admits
  only hosts in `exomem_oauth_admitted_cimd_hosts` (`claude.ai`, `chatgpt.com`),
  so the client stops at `/exomem/authorize/unknown-app`.
- **Grok** uses RFC 7591 dynamic client registration. That lane exists but
  ships disabled, so the metadata document does not advertise a
  `registration_endpoint`.

Both are ordinary standards-conforming clients. The generic lane was designed
to admit exactly this class; what is missing is CIMD's participation in it.
An unlisted host can serve a metadata document just as well as an allowlisted
one — the allowlist's real job is naming a *known platform* and keeping those
hosts admitted while the lane is off.

A second gap compounds the first: the admission predicate — enabled, not
retired, and one of pinned / allowlisted-CIMD / generic — is inlined at about
ten SQL sites across authorization, consent, owner attachment, invite
admission, token exchange, refresh, and the gateway lookup. Widening CIMD at
one site and not another would strand clients mid-flow, so the predicate must
become one rule before the new arm lands.

Finally, enabling the lane records a precondition that each client carry a
stored prominence context (coding vs conversation) that the owner can change.
Today every consumer re-derives it from redirect URIs; a desktop chat app with
a loopback callback is permanently typed "coding" with no recourse.

## What Changes

- **One admission rule.** Migration 0088 adds
  `exomem_oauth_client_admitted(...)`, a SQL function over the client row's
  columns, and every admission site calls it — including the reviewer path,
  which passes "no uncertified admission" and therefore stays certified-only.
- **Open CIMD under the lane.** A CIMD client is admitted when its host is
  allowlisted (platform-bound, unchanged) or, only while the generic lane is
  enabled, when the lane admits generic clients. An unlisted host registers
  with `client_platform = NULL`, no configuration digest, and a slot in the
  `generic` partition. The lane check runs before any metadata fetch, so a
  disabled lane still costs no outbound request and every refusal stays
  indistinguishable from an unknown client.
- **Stored client context.** `exomem_oauth_clients.client_context`
  (`coding`/`conversation`) is written at registration from the redirect
  shape, backfilled the same way, and read — not re-derived — by the gateway
  (`x-exomem-client-context`, transfer tools) and the Home app list. The owner
  can change it through a new owner-authorized route and a control on the Home
  app row.
- **Honest identity on consent.** For a CIMD client the consent page shows
  the verified host that served its document (`cimd_host`) separately from the
  self-declared `client_name`, which stays labeled as the client's own claim.

## Out of scope

- Enabling the generic lane in production — a deliberate operator step after
  release, gated by the runbook's preconditions.
- A per-host registration rate limit beyond the existing per-IP bound; added
  only if a concrete abuse path shows one is needed.
- Reviewer-credential redemption by uncertified clients — stays refused.
