## 1. Schema

- [x] 1.1 Write `migrations/0048_exomem_oauth_admitted_cimd_hosts.sql` creating `exomem_oauth_admitted_cimd_hosts(platform text, host text, primary key (platform, host))` with a CHECK restricting `platform` to `('claude','openai')` and `host` to a lowercase hostname shape
- [x] 1.2 Seed the table with `chatgpt.com` → `openai`. claude.ai is deliberately NOT seeded: it is admitted by pinned digest today and works, so adding it would widen the predicate for a client that does not need it
- [x] 1.3 Add an `auto_registered boolean NOT NULL DEFAULT false` column to `exomem_oauth_clients` so provenance is explicit rather than inferred from `admission_mode`
- [x] 1.4 Replace the single client population bound with a partitioned bound: separate limits for `auto_registered = true` and `auto_registered = false`, leaving the operator partition at its current effective size
- [x] 1.5 Verify the migration applies to a database already holding pinned and CIMD clients without violating the existing `exomem_oauth_clients_cimd_metadata_valid` or `..._config_sha256_valid` CHECKs

## 2. Admission predicate

- [x] 2.1 Locate every occurrence of the cohort digest disjunction in `oauth-store.ts` by pattern rather than by remembered line numbers — there are **nine**, at lines `65, 193, 277, 444, 1015, 1306, 1453, 1766, 1985`, across three indentation depths
- [x] 2.2 Extend each live-cohort arm with the host-allowlisted alternative: `admission_mode = 'cimd'` AND `metadata_expires_at > now()` AND `cimd_host` present in `exomem_oauth_admitted_cimd_hosts` for the client's platform
- [x] 2.3 Apply the clause by a single deterministic transform keyed on the two-line disjunction, not by nine hand-edits, since a missed site fails only at a later stage and reads as an intermittent client bug
- [x] 2.4 Confirm the transform reports exactly nine substitutions and the diff is exactly nine times the clause length
- [x] 2.5 Diff all nine clauses against each other and confirm they are character-identical modulo indentation

## 3. Auto-registration at authorize

- [x] 3.1 Add a `registerAdmittedCimdClient` path that takes a `client_id`, confirms it parses as an HTTPS URL, and confirms its host is admitted — checking the allowlist **before** any network call
- [x] 3.2 Fetch and validate the document through the existing `fetchCimdMetadata`, unchanged, so SSRF protection and fetch bounds are inherited rather than reimplemented
- [x] 3.3 Upsert the client with `admission_mode = 'cimd'`, `auto_registered = true`, `client_platform` taken from the allowlist row, and the document's digest, fetch time, TTL and expiry; use a conflict target that can only ever match rows already marked `auto_registered = true`
- [x] 3.4 Enforce the auto-registration partition bound inside the same statement so a concurrent burst cannot exceed it
- [x] 3.5 Wire the path into `resolveApprovedOAuthClient`'s caller in `src/app/api/exomem/oauth/authorize/route.ts:~160` so it fires when admission returns nothing — covering both the absent-row and the expired-disabled-row cases from design decision 2
- [x] 3.6 Re-resolve admission after a successful registration and continue the transaction, so an unknown connector authorizes without a second round trip
- [x] 3.7 Add the per-address rate limit following the existing `EXOMEM_RATE_LIMITS.oauthAuthorizeClient` pattern, covering the registration attempt specifically
- [x] 3.8 Confirm every failure on this path returns the same response shape as an unknown client, so admitted hosts cannot be enumerated

## 4. Tests

- [x] 4.1 Covered at integration level: an unlisted host is refused with an assertion that no fetch was attempted. **Gap:** non-HTTPS and non-URL `client_id` shapes are guarded in code but not yet asserted by a test
- [x] 4.2 Postgres integration tests (pattern: `oauth-postgres.integration.test.ts`) proving an allowlisted-host CIMD client is admitted with a live cohort and refused without one
- [ ] 4.3 **Not written.** The two-distinct-connectors case is the actual user-facing claim of this change and is still unproven by test
- [ ] 4.4 **Not written.** The stale-disabled-row path from design decision 2 is implemented but untested
- [ ] 4.5 **Not written.** Only the partition function's per-provenance counting is asserted; filling the partition to its bound and proving operator registration still succeeds is untested
- [x] 4.6 Test proving an auto-registration upsert cannot modify an operator-managed or bootstrap-pinned client row
- [ ] 4.7 Cross-stage test proving a client admitted at `/authorize` is also admitted at token exchange, refresh and MCP call — the guard against the nine predicates drifting
- [x] 4.8 Confirm existing pinned-digest, reviewer-bootstrap and canary admission tests still pass unchanged

## 5. Verification

- [ ] 5.1 Run the full test suite and lint in the worktree
- [ ] 5.2 Review the diff specifically as a security change: confirm PKCE S256, redirect-URI host validation, SSRF protection and the `none` normalisation are all untouched
- [ ] 5.3 Open a PR whose description states plainly that this widens an admission predicate, and links the design's Risks section
- [ ] 5.4 After deploy, verify against production that a second, fresh ChatGPT connector — not the one used for promotion evidence — reaches the consent screen, since that is the observation this change exists to make possible
