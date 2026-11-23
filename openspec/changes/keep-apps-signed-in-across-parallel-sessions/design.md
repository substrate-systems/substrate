# Design: refresh-token grace for parallel sessions

## Decisions

1. **Grace window.** A spent refresh token presented by the same OAuth client row as its family, while the family and grant are unrevoked and the family is unexpired, receives a fresh pair in the same family for `EXOMEM_OAUTH_REFRESH_REUSE_SECONDS` after its spend. Default 604800 s (7 days), maximum 2592000 s (30 days); `0` or a non-integer disables reuse, matching the loader's existing contract.
2. **After the window.** The presentation is stale: refused with `invalid_grant`, and the family is *not* revoked. The rotation statement returns a `stale` result inside the same locked transaction so the refusal carries the family ID and spend age without a second query.
3. **Different client.** A spent token presented by any other client issues nothing and creates no rows, exactly as a first rotation failure does.
4. **Reuse bound.** One spent token mints at most sixteen replacement tokens: the one its spend created, plus at most fifteen reuses, counted via `parent_refresh_token_id` under the tenant lock. Parallel sessions sharing one credential legitimately need several reuses; the bound stops a stolen just-spent token from minting without limit (an unbounded seven-day window would otherwise allow ~290k chains at the per-address rate limit).
5. **Access token TTL.** Sixty minutes, and the token route reports `expires_in: 3600`. Revocation stays immediate: `findCloudOAuthAuthority` joins the family on `revoked_at IS NULL`/`expires_at > now()` and the grant on `revoked_at IS NULL` on every gateway call.
6. **Telemetry.** `exomem_oauth_refresh_reused` gains `spend_age_seconds`; refused stale presentations log `exomem_oauth_refresh_reuse_stale` with client ID, family ID and spend age. No token material is logged.

## Invariants kept

- Reuse runs through the same `replacement` CTE as a first rotation, so minted refresh tokens stay capped by `LEAST(now() + idle, family.expires_at, reviewer credential expiry)` and access tokens by the family expiry: nothing outlives the family's idle window or session ceiling.
- Admission predicates (client pinned/generic admission, current-policy join) are untouched; the merge with the in-flight admission change stays small.
- Tenant advisory lock serializes concurrent presentations of one token, so the bound is exact and simultaneous stale presentations issue at most once.

## How comparable providers handle refresh-token reuse

Filled from primary sources before review.
