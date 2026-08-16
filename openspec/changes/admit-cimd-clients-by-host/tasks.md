## 1. Schema

- [ ] 1.1 Write `migrations/0048_exomem_oauth_admitted_cimd_hosts.sql` creating `exomem_oauth_admitted_cimd_hosts(platform text, host text, primary key (platform, host))` with a CHECK restricting `platform` to `('claude','openai')` and `host` to a lowercase hostname shape
- [ ] 1.2 Seed the table in the same migration with the hosts currently carried by `EXOMEM_CIMD_ALLOWED_HOSTS` and their platforms (`chatgpt.com` → `openai`, plus the claude.ai host if it is admitted this way)
- [ ] 1.3 Add an `auto_registered boolean NOT NULL DEFAULT false` column to `exomem_oauth_clients` so provenance is explicit rather than inferred from `admission_mode`
- [ ] 1.4 Replace the single client population bound with a partitioned bound: separate limits for `auto_registered = true` and `auto_registered = false`, leaving the operator partition at its current effective size
- [ ] 1.5 Verify the migration applies to a database already holding pinned and CIMD clients without violating the existing `exomem_oauth_clients_cimd_metadata_valid` or `..._config_sha256_valid` CHECKs

## 2. Admission predicate

- [ ] 2.1 Extend the live-cohort arm in `resolveApprovedOAuthClient` (`oauth-store.ts:~57-66`) with the host-allowlisted alternative: `admission_mode = 'cimd'` AND `metadata_expires_at > now()` AND `cimd_host` present in `exomem_oauth_admitted_cimd_hosts` for the client's platform AND a live cohort row exists for that platform
- [ ] 2.2 Apply the identical clause to the sibling predicate at `~185-194`
- [ ] 2.3 Apply the identical clause to the sibling predicate at `~259-278`
- [ ] 2.4 Apply the identical clause to the sibling predicate at `~423-445`
- [ ] 2.5 Apply the identical clause to the sibling predicate at `~1006-1016`
- [ ] 2.6 Apply the identical clause to the sibling predicate at `~1284`
- [ ] 2.7 Diff all six clauses against each other and confirm they are character-identical modulo table alias, since divergence here is silent and stage-dependent

## 3. Auto-registration at authorize

- [ ] 3.1 Add a `registerAdmittedCimdClient` path that takes a `client_id`, confirms it parses as an HTTPS URL, and confirms its host is admitted — checking the allowlist **before** any network call
- [ ] 3.2 Fetch and validate the document through the existing `fetchCimdMetadata`, unchanged, so SSRF protection and fetch bounds are inherited rather than reimplemented
- [ ] 3.3 Upsert the client with `admission_mode = 'cimd'`, `auto_registered = true`, `client_platform` taken from the allowlist row, and the document's digest, fetch time, TTL and expiry; use a conflict target that can only ever match rows already marked `auto_registered = true`
- [ ] 3.4 Enforce the auto-registration partition bound inside the same statement so a concurrent burst cannot exceed it
- [ ] 3.5 Wire the path into `resolveApprovedOAuthClient`'s caller in `src/app/api/exomem/oauth/authorize/route.ts:~160` so it fires when admission returns nothing — covering both the absent-row and the expired-disabled-row cases from design decision 2
- [ ] 3.6 Re-resolve admission after a successful registration and continue the transaction, so an unknown connector authorizes without a second round trip
- [ ] 3.7 Add the per-address rate limit following the existing `EXOMEM_RATE_LIMITS.oauthAuthorizeClient` pattern, covering the registration attempt specifically
- [ ] 3.8 Confirm every failure on this path returns the same response shape as an unknown client, so admitted hosts cannot be enumerated

## 4. Tests

- [ ] 4.1 Unit tests in `src/lib/exomem-hosted/__tests__/` for the allowlist check: an admitted host passes, an unlisted host is refused before any fetch, a non-HTTPS or non-URL `client_id` is refused
- [ ] 4.2 Postgres integration tests (pattern: `oauth-postgres.integration.test.ts`) proving an allowlisted-host CIMD client is admitted with a live cohort and refused without one
- [ ] 4.3 Integration test proving two connectors from the same admitted host with different config digests are both admitted, and neither disables or rewrites the other
- [ ] 4.4 Integration test proving a client whose `metadata_expires_at` has passed is refused, then admitted again after re-registration — the stale-disabled-row case
- [ ] 4.5 Integration test proving a full auto-registration partition refuses new anonymous registrations while operator registration and already-admitted clients keep working
- [ ] 4.6 Test proving an auto-registration upsert cannot modify an operator-managed or bootstrap-pinned client row
- [ ] 4.7 Cross-stage test proving a client admitted at `/authorize` is also admitted at token exchange, refresh and MCP call — the guard against the six predicates drifting
- [ ] 4.8 Confirm existing pinned-digest, reviewer-bootstrap and canary admission tests still pass unchanged

## 5. Verification

- [ ] 5.1 Run the full test suite and lint in the worktree
- [ ] 5.2 Review the diff specifically as a security change: confirm PKCE S256, redirect-URI host validation, SSRF protection and the `none` normalisation are all untouched
- [ ] 5.3 Open a PR whose description states plainly that this widens an admission predicate, and links the design's Risks section
- [ ] 5.4 After deploy, verify against production that a second, fresh ChatGPT connector — not the one used for promotion evidence — reaches the consent screen, since that is the observation this change exists to make possible
