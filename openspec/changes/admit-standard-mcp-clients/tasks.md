## 1. One admission rule

- [x] 1.1 Migration 0088: add `exomem_oauth_client_admitted(...)` over the client row's columns, with `p_allow_uncertified` gating the generic arm
  - `migrations/0088_exomem_standard_mcp_clients.sql`. Pinned stays admitted on `enabled`; `generic` reads `exomem_oauth_generic_client_admitted`; `cimd` needs fresh metadata plus (allowlisted host with matching platform) or (lane on and uncertified allowed).
- [x] 1.2 Call it at every admission site, preserving each site's other conditions
  - `oauth-store.ts` (authorization transaction, consent, owner attachment, token exchange, refresh), `cloud-oauth.ts` (client resolution and token lookup; the `first_party` arm stays a separate disjunct), `cloud-admission.ts` (invite admission, which keeps its FOR KEY SHARE host read authoritative while the lane is off), `cloud-reviewer-access-store.ts` (passes `p_allow_uncertified = false`, so generic and lane-admitted clients can never redeem reviewer credentials).
- [x] 1.3 Grant `exomem_gateway` EXECUTE on the new function's full signature
  - `scripts/exomem-cloud-grants.sql`, guarded for pre-0088 databases like the other grants.

## 2. Open CIMD under the generic lane

- [x] 2.1 `registerAdmittedCimdClient`: check the allowlist, then the lane, before any metadata fetch
  - Unlisted host + lane off → refusal identical to an unknown client, no outbound request. Unlisted host + lane on → fetch through the unchanged SSRF-bounded path.
- [x] 2.2 Register lane-admitted hosts with `client_platform = NULL`, `oauth_client_config_sha256 = NULL`, kept `cimd_host`, `admission_mode = 'cimd'`
  - The null-pairing CHECK already requires both-or-neither. The upsert still refuses rows of other modes/provenance, so an unlisted host cannot rewrite an operator-managed client.
- [x] 2.3 Count lane-admitted CIMD rows in the `generic` partition
  - `exomem_oauth_client_partitions()` keeps its exact `(client_partition, bound, used)` signature; `generic` counts `admission_mode = 'generic'` plus auto-registered rows with `client_platform IS NULL`. `exomem_oauth_client_partition_available_for(client_id, partition)` lets an unretired existing row keep its slot.
- [x] 2.4 Refresh/re-fetch path admits unlisted hosts by the same rule
  - `/token`'s `refreshCimdMetadataState` reuses `registerAdmittedCimdClient`, so the lane check gates re-fetch; lane off → `503`/`server_error` like a withdrawn host.

## 3. SSRF confidence for arbitrary hosts

- [x] 3.1 Verify `fetchCimdMetadata` holds for any hostname and cover gaps in unit tests
  - Every DNS answer must be public (one disallowed answer rejects the fetch); the request pins the chosen literal IP while preserving SNI (no rebinding window); redirects are refused; body, header and time are bounded. Added focused `isCimdNetworkAddressAllowed` cases: IPv4-mapped IPv6, IPv6 ULA/link-local, and private ranges.
- [x] 3.2 No per-host rate limit beyond the existing per-IP bound
  - A flood of distinct hosts from one address is already bound by the per-IP limit and the generic partition bound; no realistic path needed a per-host limit.

## 4. Stored client context

- [x] 4.1 Migration 0088: `client_context text NOT NULL DEFAULT 'conversation' CHECK (IN ('coding','conversation'))` on `exomem_oauth_clients`, backfilled from redirect shape, and `exomem_oauth_grants.client_context_override` (nullable, same CHECK)
  - All-loopback redirect lists → `coding`; anything else → `conversation`. The DEFAULT keeps the previous release's inserts working through the deploy window; the owner's choice sits on the grant because the client row is shared by every tenant's grant to it.
- [x] 4.2 Write it at every registration path
  - Generic DCR (`registerGenericMcpClient`), CIMD self-registration (`registerAdmittedCimdClient`), and operator registration/upsert (`operator-controls.ts`) all derive via `oauthClientContext`.
- [x] 4.3 Read `COALESCE(client_context_override, client_context)` instead of re-deriving
  - Gateway `cloud-handler.ts` uses `access.client.clientContext` for `x-exomem-client-context` and transfer-tool selection; `cloud-oauth.ts`'s token lookup coalesces the grant's override over the client's default; the Home app list does the same in `ownerAppRows`.
- [x] 4.4 Owner-authorized context change
  - `setOwnerAppContext` resolves the grant through `ownerAppRows`' one ownership rule (owner of the grant's tenant, Cloud resource, non-first-party client, indistinguishable 404s) and writes only that grant's override, so a change never touches another owner's app. `POST /api/exomem/apps/[id]/context`, `setAppContext` in `home-api.ts`, and a segmented "Chat app"/"Coding agent" control on the Home app row. CIMD re-registration preserves the stored choice.
- [ ] 4.5 Per-host withdrawal for lane-admitted CIMD hosts (follow-up)
  - With the lane open, the only one-action withdrawal for a single host is closing the whole lane, which also cuts every generic client. A per-host block list is an open follow-up; the runbook says so honestly.

## 5. Consent identity

- [x] 5.1 Show the verified vouching host separately from the declared name
  - `ConsentApp.vouchedHost` = the client's `cimd_host`; the consent page renders "Verified host" beside "App-supplied name", and the generic-client claim copy is unchanged for clients with no metadata host.

## 6. Documentation and verification

- [x] 6.1 Update the operations runbook
  - `docs/runbooks/exomem-cloud-operations.md`: CIMD admission now admits via allowlist or lane; lane enable widens to arbitrary CIMD hosts; lane withdrawal also stops unlisted-host CIMD clients; the stored-context enable precondition is marked done; deploy order notes the new function must precede the gateway image that calls it.
- [x] 6.2 Tests
  - Postgres integration: lane-off unlisted CIMD refuses with no fetch; lane-on registers to the generic partition, authorizes, exchanges, refreshes and is admitted by the gateway lookup; lane flipped off afterwards refuses at every stage; allowlisted hosts and pinned clients unchanged; Grok-style public redirect and loopback redirect register under the lane with the right stored context; generic lane clients cannot redeem reviewer credentials; owner context changes only their own app and survive re-registration. Unit: SSRF address classes, fixtures updated for the new non-null columns.
- [ ] 6.3 Archive after release
  - This change stays unarchived until it ships.
