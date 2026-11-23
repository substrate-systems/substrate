## Implementation

- [x] 1. Raise `EXOMEM_OAUTH_REFRESH_REUSE_SECONDS` default to 604800 and maximum to 2592000 in the session-policy loader, keeping `0` off.
- [x] 2. Extend `ACCESS_TOKEN_TTL_SECONDS` to 3600 and return it as `expires_in` from the token route.
- [x] 3. Replace replay revocation with a stale result in `rotateOAuthRefreshTokenAtomic`, bounded to sixteen replacements per spent token, under the tenant lock.
- [x] 4. Log `exomem_oauth_refresh_reuse_stale` on stale refusal and `spend_age_seconds` on `exomem_oauth_refresh_reused`; update the runbook's Connected-app sessions section.
- [ ] 5. Verify against PostgreSQL: 2-hour grace reuse, 8-day stale refusal without revocation, different-client refusal, revoked family/grant refusal, the sixteen-replacement bound, and `expires_in` of 3600.
- [ ] 6. Complete typecheck, lint, scoped unit and integration suites, then independent review and release.
