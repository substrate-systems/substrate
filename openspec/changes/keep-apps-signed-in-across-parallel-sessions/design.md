# Design: refresh-token grace for parallel sessions

## Decisions

1. **Grace window.** A spent refresh token presented by the same OAuth client row as its family, while the family and grant are unrevoked and the family is unexpired, receives a fresh pair in the same family for `EXOMEM_OAUTH_REFRESH_REUSE_SECONDS` after its spend. Default 604800 s (7 days), maximum 2592000 s (30 days); `0` or a non-integer disables reuse, matching the loader's existing contract.
2. **After the window.** The presentation is stale: refused with `invalid_grant`, and the family is *not* revoked. The rotation statement returns a `stale` result inside the same locked transaction so the refusal carries the family ID and spend age without a second query.
3. **Different client.** A spent token presented by any other client issues nothing and creates no rows, exactly as a first rotation failure does.
4. **Reuse fan-out guard.** One spent token mints at most sixty-four children — the one its spend created, plus at most sixty-three reuses — counted via `parent_refresh_token_id` under the tenant row lock. This is a loop guard for a client stuck re-presenting one token, not a theft bound: every minted token fans out on its own spend, so only family or grant revocation ends what a stolen token starts. Heavy users run many parallel sessions, and refusing the Nth presentation of a token that a store-clearing client holds would itself sign every session out, so the guard sits well above ordinary fan-out.
5. **Access token TTL.** Sixty minutes, and the token route reports `expires_in: 3600`. Revocation stays immediate: `findCloudOAuthAuthority` joins the family on `revoked_at IS NULL`/`expires_at > now()` and the grant on `revoked_at IS NULL` on every gateway call.
6. **Telemetry.** `exomem_oauth_refresh_reused` gains `spend_age_seconds`; refused stale presentations log `exomem_oauth_refresh_reuse_stale` with client ID, family ID and spend age. No token material is logged.

## Invariants kept

- Reuse runs through the same `replacement` CTE as a first rotation, so minted refresh tokens stay capped by `LEAST(now() + idle, family.expires_at, reviewer credential expiry)` and access tokens by the family expiry: nothing outlives the family's idle window or session ceiling.
- Admission predicates (client pinned/generic admission, current-policy join) are untouched; the merge with the in-flight admission change stays small.
- The tenant row lock (`FOR UPDATE OF tenant`) serializes concurrent presentations of one token, so the bound is exact and simultaneous stale presentations issue at most once.

## How comparable providers handle refresh-token reuse

The sources below are the vendors' own documentation, read 2026-11-23. The Cloudflare row is from its source code.

| Provider | Rotation | Reuse of a spent token | Refresh lifetime | Access lifetime |
|---|---|---|---|---|
| Google OAuth 2.0 | Not documented; the refresh token is returned only on first authorization | Not applicable | Ends after 6 months unused; 100 live tokens per account and client, and a new token drops the oldest | Not stated |
| Microsoft identity platform | Yes | Old tokens are **not** revoked; clients are told to delete them | 90 days (24 h for SPAs) | Not stated on the page |
| Auth0 | Yes | Reuse revokes the family; the leeway is off by default and set in seconds; only the previous token counts | 30 days by default, at most 1 year, not extended by rotation | 24 h by default |
| Okta | Yes | 30 s grace by default (0–60 s); reuse after it revokes the latest token and its access tokens | Unlimited by default; ends after 7 days unused | 60 min (org server) |
| Atlassian 3LO | Yes | 10 min reuse interval; breach detection applies after it | 90 days unused, reset on rotation | Not stated |
| GitHub App user tokens | Yes | Strictly single use | 6 months | 8 h |
| Cloudflare workers-oauth-provider (used by many remote MCP servers) | Yes | The immediately previous token stays valid, with no time limit, until its successor is used; older tokens get `invalid_grant`; the family is never revoked | 30 days by default; sliding idle expiry is optional | 60 min |

Sources:
- https://developers.google.com/identity/protocols/oauth2
- https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation
- https://developer.okta.com/docs/guides/refresh-tokens/main/
- https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/
- https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
- https://github.com/cloudflare/workers-oauth-provider (`src/oauth-provider.ts`, commit dbd149a)

Where this change sits:
- Published grace windows run from none to 10 minutes. A 7-day window for a spent token from the same client is far longer than any of them.
- Two providers never revoke a family when a spent token comes back: Microsoft, and Cloudflare's provider for MCP servers. Cloudflare limits this to the previous token; this change allows any spent token in the window, with a fan-out guard of 64 children per spent token.
- We choose the longer window because the clients that connect here (Claude Code, Codex) share one token store across parallel processes. An idle process can present a token two or more generations old hours after another process rotated it. Under a previous-token-only rule that process is refused, and Claude Code then clears the shared store for every session.
- The controls that remain:
  - Family and grant revocation (Disconnect on Home) take effect at once on every MCP call.
  - The idle window and the session ceiling still end every family.
- One correctness rule, not a control: a spent token is honoured only for the client it was issued to. The client ID is public, so this binds lineage rather than authenticating the presenter — it narrows a stolen token to whoever can claim the same client ID, which is everyone.
