## Implementation

- [x] 1. Raise `EXOMEM_OAUTH_REFRESH_REUSE_SECONDS` default to 604800 and maximum to 2592000 in the session-policy loader, keeping `0` off.
- [x] 2. Extend `ACCESS_TOKEN_TTL_SECONDS` to 3600 and return it as `expires_in` from the token route.
- [x] 3. Replace replay revocation with a stale result in `rotateOAuthRefreshTokenAtomic`, with a fan-out guard of sixty-four children per spent token under the tenant row lock.
- [x] 4. Log `exomem_oauth_refresh_reuse_stale` on stale refusal and `spend_age_seconds` on `exomem_oauth_refresh_reused`; update the runbook's Connected-app sessions section.
- [x] 5. Verify against PostgreSQL: 2-hour grace reuse, 8-day stale refusal without revocation, different-client refusal, revoked family/grant refusal, the sixty-four-child fan-out guard, CIMD refetch for an in-grace spent token, and `expires_in` of 3600.
- [x] 6. Complete typecheck, lint, scoped unit and integration suites, then independent review and release. (Two review passes on #321; merged as b2d1f89 and deployed to production 2026-11-24.)
