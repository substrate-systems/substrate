# Harden hosted-backup operations: cron wiring, R2 garbage collection, auth rate limiting

## Why

A pre-release audit (2026-06-11) of the hosted-backup feature across all three
repos found the GUI and engine release-ready but three operational holes in
substrate:

1. **Crons never fire.** `/api/cron/claim-followups` is fully implemented
   (24h/7d claim nudges + 14d founder digest, CRON_SECRET-gated) but the repo
   has no `vercel.json`, so Vercel never schedules it. The archived
   `wire-anonymous-buyer-account-linking` change left task 9.2 ("add the
   vercel.json cron entry") unchecked. Anonymous buyers who lose the claim
   email currently get no follow-up at all.
2. **R2 garbage collection is a stub.** `/api/cron/backup-gc` returns
   `{ok, todo}` and has no auth check. Soft-deleted versions (the 7-day GC
   window promised by migration 0006) are never purged from R2. Worse,
   `DELETE /api/backups/:id` and account deletion are *hard* DB deletes whose
   R2 prefix is returned to the caller and then lost server-side
   (`audit_log_account_deletions` stores only `sha256(userId)`), so their R2
   objects can never be purged later — while the account UI promises data is
   "purged within 24 hours" and the engine's push-failure remediation promises
   "the half-uploaded version is garbage-collected by substrate". Both
   promises are currently broken; encrypted-at-rest data accumulates
   indefinitely (privacy promise + storage cost).
3. **No rate limiting on credential endpoints.** `/api/auth/login`,
   `/api/auth/signup`, and `/api/auth/recover` accept unlimited attempts.
   Argon2id makes offline cracking expensive, but online credential stuffing,
   recovery-key brute force, and email enumeration are unthrottled.

## What Changes

- **New `vercel.json`** scheduling `claim-followups` daily at 12:00 UTC and
  `backup-gc` daily at 03:17 UTC. Vercel invokes both with
  `Authorization: Bearer ${CRON_SECRET}`.
- **New migration `0016`**:
  - `r2_purge_queue` table — durable queue of R2 prefixes to purge
    (`r2_prefix`, `enqueued_at`, `purged_at`).
  - `rate_limit_events` table — sliding-window event log for auth throttling.
  - `backup_versions.manifest_seen_at` column — GC bookkeeping so healthy
    versions are HEAD-checked against R2 at most once, not daily forever.
- **Atomic purge enqueue on hard deletes.** Backup deletion
  (`deleteBackupOwned`) and account deletion (`deleteUserCascade`) become
  single-statement CTEs that enqueue the R2 prefix in the same statement as
  the DELETE, so a prefix is enqueued if-and-only-if the delete happened.
  API response shapes are unchanged.
- **Implemented `backup-gc` cron** (CRON_SECRET-gated like claim-followups),
  four bounded passes per daily run, all idempotent and crash-safe (R2
  deletes happen before DB row removal, so a re-run resumes cleanly):
  - **Pass A** — purge soft-deleted versions older than 7 days: delete chunk
    + manifest objects from R2, then hard-delete the version rows.
  - **Pass B** — drain `r2_purge_queue`: list + delete objects under each
    prefix, mark `purged_at` only once the prefix lists empty.
  - **Pass C** — sweep abandoned uploads: a version whose manifest object
    never appeared in R2 48h after mint can never complete (presigned PUT
    URLs expire in 5 minutes), so soft-delete it; Pass A purges it later.
    Versions whose manifest is present are stamped `manifest_seen_at` and
    never re-checked.
  - **Pass D** — prune `rate_limit_events` older than 24h.
- **App-level rate limiting** (`src/lib/hosted-backup/rate-limit.ts`,
  DB-backed window counters, throws the existing `RATE_LIMITED` 429):
  - `login`: per-IP 30 failures / 15 min, per-account 10 failures / 15 min.
  - `recover`: per-IP and per-account 5 failed proofs / hour.
  - `signup`: per-IP 10 attempts / hour.
- **Runbook**: document `CRON_SECRET` (generation, install, verification) in
  `docs/runbooks/production-keys-and-storage.md`.

## Capabilities

### Added Capabilities

- `hosted-backup-operations`: scheduled cron execution, R2 garbage
  collection (soft-deleted versions, hard-delete purge queue, abandoned
  uploads), and credential-endpoint rate limiting.

## Out of scope

- Storing claim tokens in a re-sendable form (hash-only storage is a
  documented v1 limitation; the nudge email stands).
- Vercel WAF rules (may be layered on later; app-level limits are the
  testable source of truth).
- Lapsed-subscription data-retention policy (business decision, post-launch).
