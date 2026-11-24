# Keep connected apps signed in across parallel sessions

## Why

Every refresh rotates the refresh token. Before this change, a spent token presented more than sixty seconds after its spend counted as a replay and revoked the whole token family. Claude Code and Codex share one token store across many parallel processes, and a process can present a token another process rotated minutes to hours earlier. Such a presentation revoked the family, the app cleared its store on `invalid_grant`, and every session of the app signed out at once. Fifteen-minute access tokens multiplied the refreshes and the races.

## What changes

- Raise the same-client refresh-reuse window to seven days by default (`EXOMEM_OAUTH_REFRESH_REUSE_SECONDS`, maximum thirty days; `0` still disables reuse).
- Refuse a spent token presented after the window with `invalid_grant` without revoking the family; the family's other live tokens keep working.
- Cap one spent token at sixty-four children, counted under the tenant row lock on the already-indexed parent column. This is a loop guard for a client stuck re-presenting one token, not a theft bound.
- Let a spent token inside the reuse interval trigger the refetch of lapsed client metadata, as a live token does, so a self-registering client's daily metadata lapse signs nothing out.
- Extend access tokens to one hour (`expires_in: 3600`); revocation stays immediate because every gateway call checks the family and grant.
- Log `spend_age_seconds` on `exomem_oauth_refresh_reused` and add `exomem_oauth_refresh_reuse_stale` for refused stale presentations, metadata only.
- Keep different-client presentations refused as before, and keep every admission, family and grant check identical for reuse as for a first rotation.

## Impact

Connected apps that share one stored credential across parallel processes stay signed in; a lost reply or a stale sibling stops signing out every session. A stolen just-spent token can mint new chains inside the window instead of none, and the fan-out guard does not bound that: every minted token fans out on its own spend. Only a family or grant revocation ends what a stolen token starts, and owner Disconnect in Home remains that endpoint. Migration 0092 adds one function, `exomem_oauth_refresh_reuse_opens_at`, which holds the reuse-interval boundary that rotation and metadata refetch both read; the fan-out guard uses the parent index from migration 0067.
