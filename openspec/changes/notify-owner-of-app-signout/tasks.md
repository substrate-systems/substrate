# Tasks

## 1. Schema

- [x] Migration `0089_exomem_app_signout_notices.sql`: ended-at IMMUTABLE
      function, `exomem_oauth_app_signout_notices` marker table, ended-family
      expression index, per-grant covering index for the Home aggregate,
      emailed-cap partial index, `app_signout` outbox kind.

## 2. Home reachability

- [x] `ownerAppRows` lateral per-grant family aggregate; `OwnerApp.session`
      (`signed_in` | `signed_out` | `unknown`, `since`).
- [x] `readApps` keeps a row whose session is absent or malformed as unknown.
- [x] `appMeta` renders signed-in / signed-out-since / unknown copy.

## 3. Detection and email

- [x] `oauth-signout-notice.ts`: closed silent-reason set, bounded batched
      sweep query, per-family marker + per-grant 24 h cap, enqueue, operator
      event.
- [x] `app_signout` email definition: payload shape, send-time `stillHolds`,
      renderer.
- [x] `pruneExpiredOAuthState` runs the lane; reconcile route surfaces counts.

## 4. Verification

- [x] Unit tests: state/copy branches, silent-reason set.
- [x] Postgres integration: all-revoked lists signed out; replay-revoked
      recent grant → exactly one email row across two sweeps; owner
      disconnect → none.
- [x] `openspec validate --all --strict`; tsc; eslint; scoped tests.
- [x] EXPLAIN on a realistic local row count (≥1,000 accounts × ~50 clients).
- [x] Runbook "Connected-app sessions": new behaviour, cap, event.
