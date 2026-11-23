# Design: admit-standard-mcp-clients

## One admission predicate

`exomem_oauth_client_admitted(p_admission_mode, p_enabled,
p_metadata_document_digest, p_metadata_fetched_at, p_metadata_ttl_seconds,
p_metadata_expires_at, p_cimd_host, p_client_platform, p_allow_uncertified,
p_as_of)` encodes:

- not `enabled` → false;
- `pinned` → true;
- `generic` → the generic lane's enabled state;
- `cimd` → metadata fresh at `evaluated_at`, and either `cimd_host` sits in
  `exomem_oauth_admitted_cimd_hosts` with a matching `client_platform`, or the
  lane is enabled and `allow_uncertified` is true.

Every previously inlined site calls it with its row's columns and
`allow_uncertified = true`, except the reviewer-credential path, which passes
`false` and so keeps refusing generic and lane-admitted clients. Each site's
other conditions (grant liveness, redirect binding, invite state) are
unchanged. The first-party arm stays a separate disjunct at the gateway,
because server-minted Home tokens are admitted on `enabled` alone.

## Unlisted-host CIMD under the lane

`registerAdmittedCimdClient` gates on the allowlist *or* the lane before
fetching, so a disabled lane never pays for an outbound fetch and every
refusal answers like an unknown client. A lane-admitted row stores
`client_platform = NULL` and `oauth_client_config_sha256 = NULL` (the schema's
null-pairing check already requires both or neither), keeps `admission_mode =
'cimd'` and `cimd_host`, and is written through the generic partition's gate.
The metadata fetch itself is unchanged: DNS must resolve only public
addresses, the request pins one address with the original SNI, redirects are
refused, and body, header and time bounds apply — arbitrary hosts inherit the
same transport.

Re-registration never rewrites another mode's row: the upsert refuses any
existing row that is not an auto-registered CIMD row for the same identity, so
an unlisted host cannot take over an operator-managed client.

## Partitions

`exomem_oauth_client_partitions()` keeps its `(client_partition, bound, used)`
shape and counts unretired rows. `generic` now counts every unretired
`admission_mode = 'generic'` row plus auto-registered rows with
`client_platform IS NULL` (lane-admitted CIMD). A lane-admitted client flood
therefore spends the same bound as a DCR flood.

## Stored client context

`client_context` is a check-constrained `text` (`'coding' | 'conversation'`)
with `DEFAULT 'conversation'`, set at registration by the existing
redirect-shape rule (all-loopback → coding, otherwise conversation) and
backfilled the same way. The default keeps the previous release's client
inserts working against the new schema during the deploy window. The owner's
choice lives on `exomem_oauth_grants.client_context_override` (nullable, same
closed set), because the client row is shared by every tenant's grant to one
global client. Readers take `COALESCE(override, client_context)`: the gateway
forwards it as `x-exomem-client-context` and uses it to pick transfer tools,
and Home lists it. `setOwnerAppContext` resolves the grant through
`ownerAppRows`' one ownership rule — owner of the grant's tenant, Cloud
resource, live grant, non-first-party client — behind
`POST /api/exomem/apps/[id]/context`, which answers malformed, unknown and
foreign IDs identically.

## Deploy order

Web deploy runs migration 0088 and the grants script first; the function and
column exist before any caller needs them. The new gateway image — which
selects `client_context` and calls `exomem_oauth_client_admitted` — rolls
after; the old gateway's inlined predicate stays valid against the new schema
during the window because the migration only adds a column and a function.
