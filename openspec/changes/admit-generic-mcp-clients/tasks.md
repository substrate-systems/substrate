## 1. Schema

- [ ] 1.1 Write `migrations/0050_exomem_generic_mcp_clients.sql` adding `'generic'` to the admission-mode domain and permitting `client_platform IS NULL` for that mode alone, leaving the existing `(client_platform IS NULL) = (oauth_client_config_sha256 IS NULL)` invariant intact for the other modes
- [ ] 1.2 Confirm the migration applies to a database already holding pinned, bootstrap-pinned and auto-registered CIMD clients without violating `exomem_oauth_clients_cimd_metadata_valid` or `..._config_sha256_valid`
- [ ] 1.3 Add authoritative lane state — a single-row table or equivalent — that the admission predicates can read directly, defaulting to disabled
- [ ] 1.4 Extend `exomem_oauth_client_partition_available` to a third provenance partition, leaving the operator bound at 32 and the auto-registered bound at 128
- [ ] 1.5 Prove the generic partition cannot be counted against either existing partition, in both directions

## 2. Admission predicate

- [ ] 2.1 Locate every occurrence of the cohort disjunction in `oauth-store.ts` by pattern rather than by remembered line numbers, and record the count before editing
- [ ] 2.2 Add the generic arm by a single deterministic transform keyed on the shared clause, not by hand-edits, and confirm the substitution count equals the site count found in 2.1
- [ ] 2.3 Diff all resulting arms against each other and confirm they are character-identical modulo indentation
- [ ] 2.4 Confirm the generic arm consults lane state and admission mode only — never `exomem_hosted_alpha_platform_cohort`, never a configuration digest, never a platform
- [ ] 2.5 Confirm no existing arm changed, by diffing the certified clauses against `main`

## 3. Registration endpoint

- [ ] 3.1 Add `registerGenericMcpClient` validating RFC 7591 shape, `token_endpoint_auth_method` of `none`, and redirect URIs as https-no-credentials-no-fragment-bounded, plus loopback http for local clients
- [ ] 3.2 Reuse the existing redirect helpers rather than reimplementing them, extending them only where loopback genuinely requires it
- [ ] 3.3 Enforce the generic partition bound inside the same statement as the insert, so a concurrent burst cannot exceed it
- [ ] 3.4 Use a conflict target that can only ever match rows already marked generic, so no other admission mode can be created, enabled or rewritten by this path
- [ ] 3.5 Add `src/app/api/exomem/oauth/register/route.ts`, rate limited per address following the `EXOMEM_RATE_LIMITS.oauthAuthorizeClient` pattern
- [ ] 3.6 Return one indistinguishable response for every failure, including lane-disabled, so the endpoint discloses neither lane state nor any existing client
- [ ] 3.7 Advertise `registration_endpoint` in authorization server metadata only while the lane is enabled

## 4. Tests

- [ ] 4.1 An unknown client registers and immediately authorizes, and the same client is admitted at token exchange, bearer use, the MCP lookup and refresh — extend the cross-stage drift test rather than writing a parallel one
- [ ] 4.2 Withdrawing lane state stops admission at every one of those stages, which is the drift guard for the new arm
- [ ] 4.3 Mutation-check 4.2: removing the generic arm from exactly one predicate fails exactly that test and nothing else
- [ ] 4.4 A generic client authorizing for an identity with neither invite nor tenant creates no tenant, entitlement, grant or token, and the refusal does not disclose whether the identity is known
- [ ] 4.5 Certified admission is unchanged with the lane enabled: pinned-digest and host-allowlist clients still require a live cohort for their own platform, and the existing suites pass unmodified
- [ ] 4.6 A generic client is admitted while no cohort is live for any platform, and a certified client in the same state is still refused — the assertion that the lanes are genuinely independent
- [ ] 4.7 Registration refuses every unsafe redirect shape and writes no row; loopback http is accepted and non-loopback http is not
- [ ] 4.8 The generic partition fills to its bound and refuses further registrations while operator and CIMD partitions still report free slots
- [ ] 4.9 Registration cannot create, enable or rewrite an operator-managed, bootstrap-pinned or auto-registered CIMD client
- [ ] 4.10 Metadata advertises no `registration_endpoint` while disabled, and the endpoint refuses indistinguishably in that state

## 5. Documentation

- [ ] 5.1 Runbook section: what the lane widens, how to enable it, how to withdraw it in one action, and what withdrawal does to live grants
- [ ] 5.2 State plainly in the runbook that attribution — which software wrote a memory — is not recoverable from admission state once the lane is enabled
- [ ] 5.3 Update the connect-first landing copy to give the endpoint URL for arbitrary clients, once the lane is enabled

## 6. Verification

- [ ] 6.1 Full CI integration set, unit suite, `tsc --noEmit`, `eslint .`, and `openspec validate --all --strict`
- [ ] 6.2 Review the diff specifically as a security change: confirm PKCE S256, exact redirect binding, SSRF protection, code single-use and audience binding are all untouched, and that the invite remains the sole path to tenancy
- [ ] 6.3 Independent review of the consent screen against this widening — with any client able to ask, the consent surface is what a person actually relies on, and it should name the client and scopes plainly
- [ ] 6.4 Open a PR that states plainly that this reverses the alpha's generic-admission prohibition, and links the design's Risks section
- [ ] 6.5 Deploy with the lane disabled and confirm from production that metadata advertises no registration endpoint and the route refuses
- [ ] 6.6 Only after the friends alpha is stable, enable the lane and verify one real third-party MCP client — Codex CLI is the intended first — completes registration, authorization, tool discovery and a durable capture
