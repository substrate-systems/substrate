# Implementation handoff — conversion-funnel analytics (PostHog Wave 2)

Read this before reading anything else in this change. It exists because the
constraints below were *not* loaded as an input the first time this work was
planned, and the plan had to be corrected twice as a result.

## Read in this order

1. This file — constraints and the one open decision
2. `proposal.md` — why
3. `design.md` — technical decisions, with alternatives and why they were rejected
4. `specs/conversion-analytics/spec.md` — the requirements you must satisfy
5. `tasks.md` — the work, in dependency order

## Hard constraints — violating any of these fails the change

**1. Endstate's CLI and GUI carry no telemetry. This is a published commitment.**

Stated four ways in public copy: `public/llms-full.txt` ("No analytics, telemetry,
or tracking in the local product"), `public/llms.txt` ("Local-first, no account, no
telemetry"), the company line ("No lock-in, no telemetry"), and `/terms`.

Concretely, you may not:

- Append any analytics identifier, session id, device id, or campaign parameter to
  the `endstate://claim` deep link
- Introduce, assign, or record a persistent per-install identifier anywhere
- Add anything to the installed application

**Scope note, equally important:** this constrains the *installed product*, not the
website. `substratesystems.io` is a website and measuring its own traffic —
pageviews, download clicks, downloads served, campaign attribution, checkout — is
the entire point of this change. Do not over-apply the constraint; an earlier draft
did, and it would have suppressed metrics the founder explicitly wants.

The line is **what is counted and about whom**, not where the code runs.
`/updates/latest.json` gets an aggregate count with no identifier — that is
deliberate and approved.

**2. Analytics must never degrade the flow it observes.**

- A webhook must still acknowledge Paddle when a capture throws
- A checkout must still open and complete when PostHog is unreachable
- Everything must no-op cleanly when `NEXT_PUBLIC_POSTHOG_KEY` is unset
- No capture may delay a user-facing response beyond the existing flush bound

Captures on billing paths go **after** state persistence, never before.

**3. The privacy filter is the chokepoint and must keep holding.**

`filterPostHogCapture` in `src/lib/exomem-hosted/privacy.ts` drops any event whose
current-or-event URL is a private Exomem path. Every capture mechanism inherits it.
Assert the *filter*, not individual config flags — a previous contract test pinned
`capture_pageleave: false` as a proxy for privacy and had to be rewritten when that
flag legitimately changed.

**4. Do not enable session replay.** Masking is specified; switching it on is a
separate change. Claim and account surfaces render recovery keys and tokens.

## Reuse, do not reinvent

Wave 1 (PR #45, merged) already built the substrate:

- `src/lib/analytics.ts` — client event-name registry, `capture`, `markAnalyticsReady`
- `src/lib/analytics-server.ts` — `captureServer` (bounded 800ms flush, swallows its
  own errors), `distinctIdFromRequest` (reads the raw `Cookie` header, works with any
  `Request`)
- `/ingest` reverse proxy in `next.config.ts`, region derived from
  `NEXT_PUBLIC_POSTHOG_HOST`

Add event names to the existing registry. Do not create a parallel constants file or
inline string literals.

## Two things Wave 1 learned the hard way

- **`after()` is the wrong tool for captures that must not be lost.** It throws
  outside a request scope, so route handlers called directly in tests blow up, and a
  deferred promise can be stranded by a serverless freeze. Both fail silently. Await
  with a bounded flush instead.
- **`useSearchParams` must stay in a Suspense-wrapped leaf.** Calling it in the
  root-layout provider deopts every route out of static generation, which the blog
  and sitemap depend on.

## STOP: one open decision — do not guess

**Task 1.1 — which application identifier is canonical for `identify()`?** The
hosted-backup user id, or a licence-scoped identifier?

These may not be the same person across products. Choosing wrong permanently merges
two identities that should stay separate, and the failure is invisible until a
cohort stops making sense months later.

**Ask the founder. Do not infer it from the code.** If you cannot get an answer,
implement everything except task group 5 (identity resolution) and task 3.5
(threading into Paddle `customData`), and say so explicitly in the PR.

## Verification required before opening a PR

- `npm run lint`, `npm test`, `npm run build` all clean
- Static generation preserved for `/endstate`, `/blog`, `/blog/[slug]`
- **Run `npm ci`, not just `npm install`.** A lockfile regression in Wave 1 broke CI
  for a day because it is invisible to a local test run with `node_modules` already
  populated. If you add a dependency, verify the lock is in sync the way CI does.
- Contract test: a webhook still acks when the analytics capture throws
- Contract test: the `endstate://claim` link carries no identifier
- Contract test: the updater capture carries no identifier
- A full Paddle sandbox checkout landing intent, completion, and webhook events on
  one person

## Delivery

Work in a dedicated worktree on a task branch off the current `origin/main`. Never
the primary checkout, never `main` itself. Commit only the intended scope, push, and
open a PR with rationale and verification evidence. Keep the worktree for follow-ups.
Do not merge.
