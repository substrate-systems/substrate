## 1. Plan and schema

- [ ] 1.1 Independently critique the Cloud-only design and resolve blocking findings before implementation; validate the change strictly.
- [ ] 1.2 Add migration0058 for Cloud credential kind/lineage constraints and active-provider index; prove old kinds unchanged and invalid Cloud candidate lineage rejected in disposable PostgreSQL.
- [ ] 1.3 Propagate immutable invite sample purpose in both initial Cloud tenant inserts and require purpose equality on re-admission; test true/false creation and both mismatch directions in real PostgreSQL.

## 2. Authentication and lifecycle

- [ ] 2.1 Write red-first real-Postgres tests for eligible sample-only issuance, ordinary/ineligible tenant refusal, bounded expiry and provider separation; implement Cloud operator issuance/status without admission or purpose changes.
- [ ] 2.2 Write red-first redemption tests for kind/resource/provider/continuation binding, bad credentials, expiry/revocation and transaction theft/retry; implement atomic Cloud reviewer sessions and route dispatch with unchanged Hosted flag-off behavior.
- [ ] 2.3 Exercise the actual shared consent/code/token/refresh flow and Cloud gateway access against real PostgreSQL; enforce consistent reviewer lineage, expiry caps and refusal of Hosted kinds at every Cloud boundary.
- [ ] 2.4 Prove atomic rotation/revocation and concurrent redemption/mint refusal, preserving the other provider and ordinary accounts; implement shared lineage revocation without cohort/candidate dependencies.
- [ ] 2.5 Preserve reviewer kind/identity in resolved browser sessions, deny Cloud reviewer checkout/resume/customer-portal mutations before side effects, and recheck complimentary eligibility through credential lifetime; test ordinary/Hosted behavior remains unchanged.

## 3. Form and independent review

- [ ] 3.1 Inspect the existing rendered reviewer disclosure, reuse it for the Cloud path and render-test enabled/disabled/error/success states; verify real Chrome behavior without adding a screen or layout.
- [ ] 3.2 Reconcile the pending Cloud D2 design/spec to retain Hosted-kind refusal and document secure reviewer setup; run scoped tests, typecheck, lint and strict spec validation.
- [ ] 3.3 Obtain author-independent security review of the actual integrated diff and reproduce its important probes; resolve/recheck every blocking finding, then run the full CI matrix.

## 4. Delivery and actual acceptance

- [ ] 4.1 Merge the verified ready PR and deploy migration, least-privilege gateway grants, web and a newly published/pinned gateway image through the ordinary release process; prove ordinary and reviewer lookup under the gateway role and denial of credential hashes/digests, verify deployed bytes before enabling the reviewer flag on both processes, and disable/revoke safely on failure. No cell-image change is required for this auth scope.
- [ ] 4.2 Select or create an explicitly reviewer-purpose sample Cloud tenant, issue30-day per-provider access and prove fresh-browser OAuth plus sample bootstrap/capture/readback without owner cookies/inbox; keep credentials only in secure custody/portal fields.
- [ ] 4.3 Record delivered evidence, synchronize/archive only completed scope, and retire the clean pushed task branch/worktree.
- [ ] 4.4 Repair reviewer reconnect consent: preserve pending credential attribution, offer fresh reviewer sign-in for a previous/unbound session, retain ordinary consent and backend authorization, and verify the second connection in Chrome before recording the directory demo.

Native acceptance on 2026-10-01: the OpenAI directory draft completed fresh reviewer sign-in and authenticated tool discovery; secure reviewer fields persisted after reload. The separate private ChatGPT plugin is now on canonical0.102.0 with its app binding preserved. Reconnecting it reproduced stale-session Connect followed by `access_denied`. This web-only repair deploys independently of the cell release; sample save/readback, isolation and the video remain open.

Reconnect repair validation (2026-10-02): independent security review approved the source; 30 scoped authorization/reviewer tests, all25 real-PostgreSQL Cloud reviewer authority tests, typecheck, production build, formatting and strict OpenSpec validation passed. Chrome DevTools exercised first sign-in/consent and a second connection against a disposable localhost database with synthetic credentials and no external integration credentials. The second request offered fresh reviewer sign-in; its matching consent state persisted after reload, and both transactions were consumed with reviewer attribution. Production reconnect remains a post-deployment check. The publisher will review both prepared directory drafts before submission; no Submit or Publish action is authorized before that review.
