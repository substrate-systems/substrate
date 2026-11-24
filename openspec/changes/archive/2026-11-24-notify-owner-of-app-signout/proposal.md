# Notify an owner when a connected app is signed out

## Why

An Exomem Cloud owner's Claude Code and Codex lost access for a long time and
nobody noticed; saves the owner believed happened never reached the Exomem.
Two server-side facts made it silent:

1. Home lists an app as connected while its grant is unrevoked
   (`ownerAppRows` filters only `oauth_grant.revoked_at IS NULL`), even when
   every token family under that grant is revoked (for example
   `refresh_replayed`) or expired (idle window
   `EXOMEM_OAUTH_REFRESH_IDLE_DAYS`, ceiling `EXOMEM_OAUTH_SESSION_MAX_DAYS`).
   The app can no longer reach the cell, yet Home says it is connected.
2. Nothing tells the owner when Substrate itself ends an app's sign-in without
   the owner's action.

## What changes

- Home's app rows say whether each app can still reach the Exomem: signed in
  (at least one token family under the grant is unrevoked and unexpired), or
  signed out since a date, with what to do ("Open `<app>` and connect Exomem
  again"). The state is computed at render time from the database; an unknown
  or failed read shows unknown, never signed in.
- When an app the owner used recently (grant usage `last_used_at` within the
  last 14 days) loses its last live token family without the owner's action,
  the owner gets one email: which app, when, that nothing it saves reaches the
  Exomem until it reconnects, and how to reconnect. Owner disconnects
  (`owner_disconnected`) and account or lifecycle deletion send nothing.
- Detection runs in the existing scheduled OAuth sweep
  (`pruneExpiredOAuthState`), as one batched, bounded query over families that
  ended recently — never one query per item.
- Each ended family is notified at most once through a durable marker row,
  and at most one such email leaves per grant per 24 h, both enforced in the
  database so retries and concurrent sweeps stay idempotent.

## Out of scope

- No new revocation reasons; the existing `revoked_reason` values are read and
  classified in one place.
- No change to client admission predicates or population bounds.
- No tenant content is read; only OAuth metadata.

## Load target

The product plans for at most 1,000 accounts and about 50 clients per account
(runbook and `reclaim-oauth-client-slots` design), so tens of thousands of
grants and a multiple of that in token families. The Home read stays one
query with a correlated aggregate served by an index; the sweep query is a
bounded, indexed range scan.
