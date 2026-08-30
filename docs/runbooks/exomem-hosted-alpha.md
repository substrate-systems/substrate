# Exomem Hosted Alpha — Operator Runbook

This runbook covers the friends-only Exomem Hosted alpha. Public visitors
may express interest, but only authenticated operators issue invitations.
Paid operator invitations use the existing €5 monthly Paddle checkout; public
self-serve admission remains disabled. The private alpha runs the checked
`hosted-alpha-agent-v4` profile. Substrate is
the public account, entitlement, routing, and lifecycle control plane. Every tenant
is routed to one private Exomem cell with its own vault, state, logs, service
credential, and provider resource. A cell never receives email, browser
cookies, Paddle identifiers, database credentials, or another tenant's address.

The application side is provider-neutral. Real invitations require an HTTPS
provisioner that dual-serves `exomem-cell-provisioner.v1` and
`exomem-cell-provisioner.v2`; until that endpoint is configured, invite
redemption remains safe: complimentary owners stay in `preparing`, while paid
owners stay at checkout and no provider operation is created.

## Alpha launch gates

Complimentary access does **not** require Paddle or a price. Paid operator
invitations require checkout before provisioning. Every route does require:

1. migrations `0017` through `0051_exomem_oauth_operator_client_bound.sql` applied to the production Neon database;
2. the immutable Exomem `0.66.0` cell image from commit
   `efd6e15f40221bb3821f979d6fcbda45e7c6a649`, pinned as
   `ghcr.io/artexis10/exomem@sha256:707d06b3ee4ee8cf12ae5a9cae9514fc7e1b5fa0cda82b6a15998bdfc97c59e8`,
   exposing private protocol `1` and `hosted-alpha-agent-v4`;
3. a provisioner endpoint with persistent, tenant-isolated volumes and encrypted
   export storage;
4. all required Substrate secrets below;
5. the external K3s scheduler reaching `/api/cron/exomem-reconcile` every minute;
   and
6. a two-cell isolation/export/deletion drill before a real invite is sent.

Public launch remains deferred. Configure only the existing Exomem product and
€5 monthly price for authenticated paid invitees. Do not configure or expose the
€12 public price. Existing paid records retain their normal reconciliation and
cancellation paths; they are not authority to admit a new public visitor.

Public interest is captured at `POST /api/exomem/interest`; the former
POST `/api/exomem/access/request` remains `410 Gone` and must not
consult capacity or create invites. Issue cohort and reviewer invites only through
the authenticated operator endpoints. Migration `0038_exomem_self_serve_admission.sql`
and existing rows remain historical records; do not edit, reverse, or reuse them
to open admission.

The historical `0.34.0` unit remains an importable rollback artifact only. Its
compatibility, schema-contract, and command-surface digests were
`6da6c697c7720b2178d753299ced98f93f440134c2cbcc0fa7d741f3680d5d9c`,
`c18580d9dfa8fe549df17984487668f1ead73ba5b37fb6a07b82c68a76e30853`, and
`eddd997c22885ca913aa57dea2e6a2afaa7cb5f0dd52d87b564c1c3d7bbadc7f`.
Do not regenerate it into either bare current-fixture path; the authoritative
current `0.66.0` agent-and-gateway projection recipe is in
[Contract and artifact control](#contract-and-artifact-control).

The fixture's top-level `sourceRelease` is the trusted cell-runtime release;
it is intentionally separate from the compatibility descriptor. When the
Exomem marketplace change squash-merges, choose the resulting `main` commit
(never a temporary pull-request SHA), review the archive and compatibility
digests, set the matching cell release, regenerate both fixtures, and then
repeat promotion evidence before publishing an install action.

## Substrate configuration

Set secrets in every Vercel environment that can execute an Exomem route, then
redeploy. Never reuse a cell credential as any control-plane secret.

| Variable                                                                         | Requirement                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                   | Neon/Postgres connection used by migrations and product-scoped rows.                                                                                                                                                                                                                                                                                                  |
| `EXOMEM_PUBLIC_BASE_URL`                                                         | Required production HTTPS origin. Set it exactly to `https://substratesystems.io`; credentials, query, fragment, and non-root paths are rejected. A missing or malformed value fails discovery and MCP closed as `PUBLIC_BASE_URL_INVALID`; there is no request-derived fallback. Development HTTP is loopback-only.                                                  |
| `EXOMEM_MCP_ALLOWED_ORIGINS`                                                     | Optional comma-separated exact browser origins for MCP. Each entry must be a complete origin with no wildcard, credentials, path, query, or fragment. Do not add guessed provider origins.                                                                                                                                                                            |
| `EXOMEM_ADMIN_TOKEN`                                                             | At least 32 random bytes, known only to operators; protects invite issuance.                                                                                                                                                                                                                                                                                          |
| `EXOMEM_CONTROL_PLANE_KEY`                                                       | Exactly 32 random bytes encoded as unpadded base64url; encrypts private endpoints, cell credentials, and export references.                                                                                                                                                                                                                                           |
| `EXOMEM_PROVISIONER_ENDPOINT`                                                    | Private HTTPS base URL implementing the provisioner contract. URLs containing credentials or using HTTP are rejected.                                                                                                                                                                                                                                                 |
| `EXOMEM_PROVISIONER_CREDENTIAL`                                                  | At least 32 characters; authenticates Substrate to the provisioner.                                                                                                                                                                                                                                                                                                   |
| `EXOMEM_PROVISIONER_TIMEOUT_MS`                                                  | Optional `100..30000`; default `5000`.                                                                                                                                                                                                                                                                                                                                |
| `EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED`                                         | Deploy the dual-protocol consumer with this absent or `false`, complete the reviewed D1 expand and synthetic v2 proof, then set it to `true` before creating the reviewer canary. Only trimmed, case-normalized `true` selects v2 for a newly inserted operation. Existing operations always retain their persisted outer wire protocol through retries and restarts. |
| `EXOMEM_CF_ACCESS_CLIENT_ID`, `EXOMEM_CF_ACCESS_CLIENT_SECRET`                   | Active Cloudflare Access service-token pair used only by Vercel for the private provisioner and cell-control hostname. Production fails closed if either half is absent.                                                                                                                                                                                              |
| `EXOMEM_CF_ACCESS_CLIENT_ID_PREVIOUS`, `EXOMEM_CF_ACCESS_CLIENT_SECRET_PREVIOUS` | Optional complete previous Access pair during a bounded receiver overlap. Never configure only one half.                                                                                                                                                                                                                                                              |
| `EXOMEM_CF_ACCESS_SEND_VERSION`                                                  | Optional server-side sender selection: `active` (default) or `previous`; `previous` is valid only while the complete previous pair exists. Browser input never selects this.                                                                                                                                                                                          |
| `EXOMEM_HOSTED_TRANSFER_HOST`                                                    | Canonical public transfer DNS hostname without a scheme or path. Substrate returns direct cell-bound v2 URLs on this host; it never proxies file bodies through Vercel.                                                                                                                                                                                               |
| `EXOMEM_CELL_PROTOCOL_VERSION`                                                   | `1` for this alpha.                                                                                                                                                                                                                                                                                                                                                   |
| `EXOMEM_CELL_RELEASE_VERSION`                                                    | Exact deployed Exomem release, pinned to `0.66.0` for this release unit -- the release the hosted deployment lock names. Readiness must echo it, and the gateway contract catalog must carry the exact v4 fixture pair for it or every command fails closed.                                                                                                          |
| `EXOMEM_CELL_WORKER_COUNT`                                                       | `0` for alpha.                                                                                                                                                                                                                                                                                                                                                        |
| `EXOMEM_CELL_SEMANTIC_WORKERS`                                                   | `false` for alpha.                                                                                                                                                                                                                                                                                                                                                    |
| `EXOMEM_CELL_MEDIA_WORKERS`                                                      | `false` for alpha.                                                                                                                                                                                                                                                                                                                                                    |
| `EXOMEM_EXPORT_TTL_HOURS`                                                        | Positive integer; default `24`. Provider download URLs are separately capped at 15 minutes.                                                                                                                                                                                                                                                                           |
| `CRON_SECRET`                                                                    | Existing Vercel-only bearer for unrelated daily/weekly jobs. Never install it in the hosted K3s scheduler.                                                                                                                                                                                                                                                            |
| `EXOMEM_HOSTED_SCHEDULER_SECRET`                                                 | Dedicated active bearer shared only by the three Exomem hosted cron routes and K3s scheduler.                                                                                                                                                                                                                                                                         |
| `EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS`                                        | Optional Vercel receiver-only overlap during rotation; absent in steady state and never installed in K3s.                                                                                                                                                                                                                                                             |
| `EXOMEM_HOSTED_ALERT_TOKEN_SHA256`                                               | SHA-256 of the scheduler alert receiver capability. Required for `/api/exomem/alerts/[token]`; unset means the endpoint answers `404` to everything. Only the digest belongs here — the plaintext lives solely in the K3s-side `ALERT_WEBHOOK_URL`.                                                                                                                   |
| `EXOMEM_HOSTED_ALERT_TOKEN_SHA256_PREVIOUS`                                      | Optional receiver-only overlap during alert capability rotation; absent in steady state. A malformed value is ignored rather than widening the accepted set.                                                                                                                                                                                                          |
| `EXOMEM_HOSTED_ALERT_RECIPIENT`                                                  | Optional override for the alert notification address; defaults to `founder@substratesystems.io`. Misconfiguring it sends every alert elsewhere, so change it only deliberately.                                                                                                                                                                                       |
| `BREVO_API_KEY`                                                                  | Delivers invite, magic-link, deletion-confirmation, and scheduler alert email.                                                                                                                                                                                                                                                                                        |
| `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`                                        | Optional verified sender overrides.                                                                                                                                                                                                                                                                                                                                   |
| `PADDLE_ENVIRONMENT`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`                  | One matching Paddle environment, merchant API key, and shared webhook-verification secret. Keep them configured after disabling new checkout so existing paid accounts can reconcile, manage billing, and delete safely.                                                                                                                                              |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `NEXT_PUBLIC_PADDLE_ENVIRONMENT`              | Browser checkout token and the same explicit environment as the merchant configuration. A mismatch fails closed.                                                                                                                                                                                                                                                      |
| `EXOMEM_PADDLE_CATALOG_ENVIRONMENT`, `EXOMEM_PADDLE_PRODUCT_ID`                  | The environment and existing Exomem Hosted product selected only by the server.                                                                                                                                                                                                                                                                                       |
| `EXOMEM_PADDLE_PRICE_ID`                                                         | The existing €5 monthly price. This is the narrow new-checkout gate: leave it absent during deployment verification, set it only for the controlled paid rollout, and never point it at the €12 public price.                                                                                                                                                         |
| `OPENAI_APPS_CHALLENGE`                                                          | Provider-issued single-line domain proof. Set only in deployment configuration; never commit, log, or place it in a request.                                                                                                                                                                                                                                          |
| `EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED`                                     | Leave unset or `false` by default. Set exactly `true` only after a dedicated reviewer-purpose tenant, governed fixture, and provider credential have been prepared. Disable first during rollback or incident response.                                                                                                                                               |

Rate-limit bucket identifiers are domain-separated HMACs under the control-plane
key, never plain hashes of email or IP addresses. Buckets older than the longest
configured window plus a one-hour margin are pruned in bounded batches by the
access-delivery cron.

The anonymous friends-cohort invite-request endpoint takes durable, HMAC-keyed
IP and normalized-email buckets before it calls Brevo. A denied bucket returns a
content-safe `429` with `Retry-After`; an unavailable durable limiter fails
closed with a content-safe `503` and `Retry-After`, so it cannot spend the shared
email quota. Configure complementary Vercel edge/WAF rate limiting for
`/api/exomem/interest` to absorb request floods before they reach the application.
The edge rule is a burst-control layer, not a replacement for the durable
application buckets, and must not log raw request email addresses or IPs.

Uploads and downloads use two steps. The authenticated same-origin route receives
only bounded metadata and returns a five-minute signed ticket. The browser then
sends raw bytes directly to `EXOMEM_HOSTED_TRANSFER_HOST` with cookies omitted.
The ticket binds the active credential version, canonical Substrate origin,
operation, method, cell, principal, UUIDv4 JTI, byte limit, and exact upload
metadata or download path. Uploads are capped at 90 MiB. The cell durably consumes
the JTI before reading or opening bytes, so an interrupted transfer requires a
fresh ticket and replay remains rejected after a pod restart.

Deletion revokes browser sessions and stops new ticket issuance immediately,
then quiesces the exact cell before waiting on Paddle. An already issued ticket
is a five-minute capability: it can remain usable only until cell quiescence is
observed or that TTL expires, whichever happens first. This bounded window is
accepted for the private beta; suspected credential compromise still requires
immediate cell quiescence and credential rotation.

## MCP OAuth, capacity, and client promotion

The canonical protected resource is
`https://substratesystems.io/api/exomem/mcp/v1`. Its only supported discovery
paths are:

- `/.well-known/oauth-protected-resource/api/exomem/mcp/v1`;
- `/.well-known/oauth-authorization-server/api/exomem/oauth`; and
- `/api/exomem/oauth/authorize`, `/token`, and `/revoke`.

Do not publish a tenant-specific connector URL, alternate resource origin, or
manual package configuration. MCP bearer credentials belong only in the
`Authorization` header; never put them in a URL, cookie, tool argument, log,
or cell header. Discovery, failed authentication, and `initialize`/`tools/list`
must not create or wake a tenant cell.

The MCP public front door resolves `EXOMEM_PUBLIC_BASE_URL` first, then rejects
a present unlisted or malformed browser `Origin` with a content-free 403 before
any database work. Missing `Origin` remains valid for server-to-server clients.
The canonical Substrate origin and only exact entries in
`EXOMEM_MCP_ALLOWED_ORIGINS` are allowed; `null`, wildcards, credentials,
paths, queries, fragments, neighboring domains, and wrong ports are not. After
the cheap selector/header checks, a missing or malformed bearer receives the
static OAuth 401 challenge without a database-backed rate-limit or token lookup.
A structurally valid bearer enters the durable IP rate limiter before its token,
tenant, entitlement, or cell is consulted. Protect the static unauthenticated
challenge with the Vercel edge/WAF rule rather than adding an anonymous database
write back into this path.

`EXOMEM_CONTROL_PLANE_KEY` protects the OAuth continuation and control-plane
secrets. Alpha has one envelope key and no key ID: it is immutable during this
alpha. Do not rotate it in place. If it is changed accidentally, restore the
exact old key before serving traffic. Never rotate by deleting token, grant, or
family rows. Revoke a compromised client family first; use account-wide
revocation only when every client must re-authorize.

The operator-held contract and promotion keys are separate from OAuth and cell
credentials:

| Variable                                                                       | Purpose                                                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `EXOMEM_HOSTED_CONTRACT_IMPORT_KEY_ID`, `EXOMEM_HOSTED_CONTRACT_IMPORT_SECRET` | Verify the signed import of the exact Exomem compatibility contract and supported client locks. |
| `EXOMEM_HOSTED_PROMOTION_KEY_ID`, `EXOMEM_HOSTED_PROMOTION_SECRET`             | Verify clean-client promotion evidence.                                                         |
| `EXOMEM_HOSTED_CLAUDE_INSTALL_URL`, `EXOMEM_HOSTED_OPENAI_INSTALL_URL`         | Server-owned promoted install locations only.                                                   |

The evidence-signing verifier has no overlapping-key support. Rotate a signing
key only when there are no pending candidates or evidence records; old signed
evidence becomes invalid and must be recollected. Do not reuse any of these
values as an OAuth, scheduler, provisioner, or cell credential.

## Marketplace readiness and domain proof

Do not submit a directory listing or claim a public install channel before the
matching client artifact is live and the public origin has passed the checks
below. The public page may describe the invite-only private alpha, but it must
not use a guessed provider URL.

OpenAI issues the value for `OPENAI_APPS_CHALLENGE`. Store the exact single-line
value in each deployment environment that serves the canonical origin, redeploy,
then request `/.well-known/openai-apps-challenge`. A configured route returns
only that plain-text value with `Cache-Control: no-store`; an absent or unsafe
value returns 404. Do not put the value in a shell command, ticket, screenshot,
test fixture, or application log.

For rotation, replace the deployment value with the newly issued proof and
redeploy before asking the provider to verify it. Confirm the new proof through
the provider workflow, then remove the retired value from operator notes and
password stores. To remove the proof, delete `OPENAI_APPS_CHALLENGE`, redeploy,
and confirm the well-known route returns 404. This route has no fallback and
must never accept a query parameter or request header as a proof.

Before deployment, verify the canonical alias, `EXOMEM_PUBLIC_BASE_URL`,
additive migrations, and route logs. Do not restart private Exomem cells as a
generic response to a discovery failure; inspect the public route status first.
After deploy, run the redacted preflight with private environment values only:

```bash
EXOMEM_PUBLIC_BASE_URL=https://substratesystems.io \
OPENAI_APPS_CHALLENGE="$OPENAI_APPS_CHALLENGE" \
npx tsx scripts/exomem-marketplace-preflight.ts
```

For controlled reviewer checks, additionally set
`EXOMEM_MARKETPLACE_REVIEWER_TOKEN` in the operator environment. The output
contains route statuses, digests, and safe tool names only; it must not contain
the challenge, reviewer token, tenant IDs, or knowledge content. A redirect,
timeout, metadata mismatch, or 5xx is stop-ship. Hand the resulting redacted
JSON evidence to Exomem's marketplace release gate, with the deployed commit
and alias recorded separately from user data.

If the release regresses public pages, discovery, or the authorization
challenge, roll back the application deployment while preserving additive
migrations and the existing tenant-routing safety controls. Re-run the public
preflight after rollback; do not use a production restart as a substitute for a
healthy front door.

Capacity is an authoritative database ledger, not a provider inventory. One
first authorization reserves exactly 5 GiB storage, one runtime slot, and one
initial-provision reservation before it creates the tenant, entitlement, grant,
or operation. `reserved`, `occupied`, and `uncertain` retain storage/runtime;
only verified destruction moves an allocation to `released`. `retained_storage`
keeps storage without runtime. The globally bounded provision claim limits
in-flight provider work independently of queued reservations. Inspect the pool,
allocation, claim lease, operation checkpoint, and stable error code together;
never free capacity because a provider response timed out or an operator cannot
find a cell by hand.

### Promotion run sheet (start here)

The procedure below is the specification. Drive it with the harness in the
`exomem` repository rather than by hand — `scripts/reviewer_bootstrap.py`
(`preflight`, `prepare`, `run`) and `scripts/promotion_evidence.py` (`observe`,
`sign`, `import`, `promote`). Every step run by hand has been got wrong at least
once, and each failure burns a single-use invite, an email alias, a stage, a
client, and usually strands a tenant that then blocks the retry.

**Promotion is one-shot per candidate, and the choice of platforms is made at
that moment, permanently.** Promoting Claude alone does not leave OpenAI to be
added later — it forecloses it on that candidate. Promotion retires the rollout
assignment, and the `cells` precondition every promotion rests on requires that
same assignment to be `active`, so once a candidate is live its own bound proof
is gone and no second platform can be paired onto it. Every OpenAI input can be
present and correct — locks on the candidate, a staged release, signed evidence,
an imported artifact, an enabled client — and the pairing still returns
`precondition_failed`. Enabling ChatGPT afterwards means a fresh candidate, a
fresh routable proof, a fresh reviewer tenant and a fresh evidence run for
_both_ platforms: the whole window again.

So decide before step 2 whether the alpha needs ChatGPT. If it does, both
clean-client runs happen in the same sitting and the promotion carries both
artifacts. If it does not, promote Claude alone knowing ChatGPT waits for a
later candidate. `openspec/changes/scope-cohort-admission-per-platform` proves
this refusal as a test rather than leaving it to be rediscovered mid-window.

For the `0.66.0` release, both clients must discover profile
`hosted-alpha-agent-v4` with exactly 25 tools in registry order and command
surface digest
`4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968`.
Thirteen tools, a v1 profile, mixed Claude/OpenAI digests, or evidence from the
expired `0.57.2` ceremony is a failed run. Do not sign or import it. After both
fresh-chat recalls pass, run `observe` → `sign` → `import` for Claude and OpenAI
inside the same staged-release window, then perform the single paired
`promote`. Reconnect both clients after promotion and prove production
discovery still reports the same ordered 25 tools before opening invitations.

Order matters more than anything else here, because two of the steps are timed
and one input has to exist before them:

1. **Create the ChatGPT connector first**, pointing at the Hosted MCP endpoint,
   and keep its connector id. `run` needs it: the OpenAI sibling stage must be
   built from the client-metadata document that connector publishes at
   `https://chatgpt.com/oauth/<connectorId>/client.json`. A sibling built any
   other way carries a digest the connector can never present, and evidence
   signed against it is refused at `import-artifact` — after the window is gone.
2. `preflight`. Read-only, spends nothing. All four gates must be green: no live
   cohort, the candidate `pending` at the intended release, no active bootstrap
   authority, free runtime and provision-claim capacity.

   Point `--repo` at a worktree of the exact release the candidate was cut from,
   and `--profile` at that candidate's profile — `hosted-alpha-agent-v4` for
   `0.66.0`. Only the default candidate's locks sit at the generated root; every
   later one lives under `candidates/<profile>`. Reading the wrong directory
   attests a different command surface than the cell serves, and it is the v1
   profile above that a wrong `--profile` produces.
3. `prepare`. Creates the stage, pinned client and invite. Still reversible: the
   invite keeps its full expiry until an authority exists.
4. `run`, with the emailed invite token and `--openai-connector`. **This starts
   the clock.** Creating the authority spends the invite whether it then
   succeeds, expires or is revoked, and the outcome assignment the canary
   credentials hang off begins expiring while the cell provisions. Do not start
   it without both real clients open.

   The window is the **staged release's** expiry, which `prepare` set and you
   chose — not the authority's thirty minutes. The assignment takes its expiry
   from the staged release; the authority is consumed by this very redemption,
   so it no longer bounds anything. Budget roughly ten minutes of that window for
   provisioning before a human can do anything: on 2026-08-22 `run` consumed the
   authority at 23:42:54 and the cell reached `CELL_READY` at 23:51:14. Size the
   staged release for provisioning plus a clean-client run on every platform you
   are promoting plus `observe`/`sign`/`import` for each, and do not try to fit
   two platforms into thirty minutes.

5. The clean-client runs, in real Claude and real ChatGPT. Nothing automates
   this, and nothing should: the evidence attests that a genuine client
   completed install, authorization, tool discovery, recall, citation, durable
   capture and fresh-chat recall. Signing those assertions without performing
   them would forge the gate rather than pass it.
6. `observe` → `sign` → `import` per platform, then `promote`. Everything that
   touches a platform before `promote` — attaching locks, staging a release,
   importing an artifact — requires the candidate to still be `pending`, so all
   of it must be finished for every platform being promoted before the single
   `promote` call.

Failure modes that have each cost a window, and are now reported rather than
guessed at:

- A bare `500` from `create-stage` is the one-staged-release-per-candidate-and-
  platform collision, left by an earlier attempt. Retrying cannot clear it; fail
  the leftover stage off first.
- Evidence must be signed against the **sibling** stage, never the bootstrap
  stage. They look alike and the wrong one validates at signing time, failing
  only at import. `run` prints both ids and writes them to
  `sibling-stage-ids.json`; take them from there, never from prose.
- `expectedRoutableCellDigest` is a compare-and-swap over the live routable set.
  Read it immediately before promoting — destroying or adding any cell moves it,
  including the reviewer tenant cleaned up afterwards.
- `routableObservationFresh` is informational. Promotion takes its own live
  probe and refreshes the authority inside its transaction, so gating tooling on
  that flag refuses promotions that would in fact succeed.
- A routable row whose cell is `lifecycle_state = deleted` is a ghost, and
  promotion live-probes every routable cell. One ghost blocks all future
  promotions with an unhelpful `precondition_failed`. Reconcile
  `exomem_routable_cell_contracts` against `exomem_cells` before starting.

Capacity is a separate gate from all of the above, and it binds earlier than
expected: the reviewer tenant holds a runtime slot for the whole window, and
each invited person holds one afterwards. Check
`GET /api/exomem/admin/capacity` against the number of people actually being
invited before opening a window, and raise the pool to match real node headroom
rather than discovering the ceiling on the fourth invitation.

### Virgin-install reviewer OAuth bootstrap

Use this procedure only when Hosted has no live cohort and no usable
internal-canary reviewer authority. It creates one fresh reviewer-purpose
tenant; never redeem a reviewer invite through the ordinary invite path, which
is legacy-unmetered and does not reserve capacity.

1. Verify privately that the candidate is pending `hosted-alpha-agent-v4`
   release `0.66.0`, contains exactly 25 ordered commands, the selected client
   release is still `staged`, capacity is
   configured, and there is no live cohort, active reviewer assignment,
   bound/ready reviewer cell, or active internal-canary credential.
2. Create and deliver one reviewer-purpose operator invite. Confirm the invite
   identity does not already own a tenant (`exomem_tenants.owner_user_id` is
   unique); if it does, stop and issue a fresh alias invite. Confirm it is
   unconsumed, unrevoked, and has a remaining expiry longer than the review
   window. Register one matching pinned client with exactly one safe HTTP
   loopback redirect.
3. Through the authenticated OAuth-client operator endpoint, create
   `create_reviewer_bootstrap` with only the invite ID, staged release ID,
   client record ID, and an expiry no more than 30 minutes away. Record only
   the returned opaque authority ID and expiry. After consumption, record the
   opaque assignment ID and returned assignment generation for exact fresh
   sibling internal-canary issuance; never copy redirects, codes,
   or invite tokens into a ticket.
4. Complete one clean OAuth authorization and redeem the delivered invite. The
   authority must become `consumed` with opaque tenant, assignment, operation,
   session, and grant outcomes. A capacity failure leaves the three inputs
   reusable; do not retry through direct invite redemption.
5. Reconcile the returned operation immediately. Its target is already pinned
   to the exact candidate and assignment. Create fresh Claude and OpenAI sibling
   stages/clients with no bootstrap history. They remain disabled after staged
   registration; issue their distinct internal-canary credentials using that
   exact tenant, candidate, assignment, and generation to authorize the bounded
   pre-promotion runs. Enable each sibling only after its exact client artifact
   has been imported. The bootstrap client remains disabled and must never be
   re-enabled, re-registered, or selected. Once either credential is issued,
   the setup session/grant/code are sealed and each clean client must authorize
   again with attributed lineage.

To stop the attempt, call `revoke_reviewer_bootstrap` with the authority ID.
Expiry and revocation disable the pinned client. Do not re-enable, re-register,
or repurpose a client with bootstrap history; prepare a new staged client and a
new authority instead.

For `TENANT_PREPARING`, `CELL_PREPARING`, capacity, or terminal provisioning
failures, return only the stable MCP error and opaque request/support reference.
Inspect the tenant/operation/claim IDs, expected release and protocol, and
readiness proof privately. A failed or stale candidate is discarded; it is never
bound or used as fallback. A same-owner second Claude/OpenAI authorization adds
its own grant/token family to the existing tenant and must not reserve capacity
or create a second cell or volume.

Suspend closes the routing gate before the provider call and retains the same
tenant/cell mapping. Resume reacquires runtime capacity as needed and reopens
routing only after exact readiness. Deletion closes routing and durably revokes
all OAuth grants, access tokens, refresh families, browser sessions, invites,
and transfers before destruction; keep it pending until compute, storage, and
keys are all proven destroyed.

### Contract and artifact control

Import the exact `hosted-alpha-agent-v4` compatibility artifact as `pending`.
Compare profile, endpoint, source release, command-surface digest,
schema-contract digest, compatibility digest, protocol range, and both client
package/archive locks. Before promotion, prove every routable cell exposes that
same private profile. Promotion is atomic: live discovery stays on the current
contract until the candidate and real clean-client evidence both verify.

The current release is Exomem `0.66.0` at
`efd6e15f40221bb3821f979d6fcbda45e7c6a649`: command surface
`4b4b71280fec7915042483207b1ab0e15e916148ac1b88ef965e03671de80968`, schema
`55f704688e015a4497f9ca8da49169a717c282aacec838bfde52c08c12cdf95c`,
compatibility `4a12a115086166c5b37cde02e6bfcc6aa2c095b6d073dc23f5634803b13c0ce9`,
Claude package `be9a2c4c32ff4cc1927fcda01aafe590d3df486ad2f570229582ba1fd371b241`,
Claude archive `00e63dece4bdd62a1cf3e708f18e2de4d61680810bd42b2da8c22c2765e902f4`,
OpenAI package `eaca4382bb3918ef0d49384de30f9d6c7d35798649702bd59c53b0315916698b`,
OpenAI archive `d04b967013e61336ecd724d5d5acecea7a56a306256c6f387baa22d62db7adc0`,
registered app `b089bdc50a051f64a3fb60c21df2c9598e7c8e601deeeb1b7bfbe15abf1d8b46`,
and private gateway `b520dbf5509519b7822d0abd628514d1c1a2ee45f2c68958cf8b5e218444accb`.
The immutable runtime candidate is SHA-256
`ef7424809847ed7aa6909b9d85fb4b5e437d1cefa45ab813d595fc31ce1a184c`
and the image digest is
`sha256:707d06b3ee4ee8cf12ae5a9cae9514fc7e1b5fa0cda82b6a15998bdfc97c59e8`.
Verify both release Sigstore attestations before any cell rollforward.
From a clean checkout at that exact commit, project both artifacts together:

```bash
node scripts/generate-exomem-hosted-contract.mjs \
  --exomem-repo /path/to/clean/exomem \
  --output src/lib/exomem-hosted/agent-contract-fixture.ts \
  --json-output src/lib/exomem-hosted/__tests__/agent-contract-fixture.json \
  --gateway-output src/lib/exomem-hosted/gateway-contract-0-66-0.ts \
  --gateway-json-output src/lib/exomem-hosted/__tests__/gateway-contract-0-66-0.json \
  --expected-commit efd6e15f40221bb3821f979d6fcbda45e7c6a649 \
  --source-release 0.66.0
```

The explicit `-0-34-0`, `-0-35-0`, `-0-39-2`, `-0-49-0`, `-0-50-0`, `-0-54-1`,
`-0-57-2`, and `-0-63-1` fixtures are retained historical units with their
original profiles; do not overwrite or regenerate them while refreshing the
current release. `-0-63-1` is the newest and the one most at risk: the previous
release's generator invocation is one `git log -p` away and still looks valid.
A retained fixture is produced by copying the outgoing bare fixture, never by
re-running the generator.

Import the current `0.66.0` catalog unit through the current control only:

```json
POST /api/exomem/admin/contracts
{ "action": "import-agent" }
```

`import-agent` imports the bare current `0.66.0` fixture. Do not send `0.66.0`
to `import-retained-agent`; that control is reserved for the explicit historical
`0.34.0`, `0.35.0`, `0.39.2`, `0.49.0`, `0.50.0`, and `0.54.1` release units.
Having a retained fixture does not make a release importable here -- `0.57.2`
and `0.63.1` both ship one and neither is accepted by this control.

Demotion is fail-closed: it stops new installs/authorizations for the affected
artifact and does not restore a previous artifact automatically. Operators must
import and re-promote the prior exact package, then re-enable admission only
after compatibility checks. Existing token families remain subject to their
normal entitlement and lifecycle checks. If no compatible live contract exists,
keep the resource unavailable rather than widening discovery.
Archive the signed import, locks, digests, opaque run reference, and
content-free result digest; never archive client content, OAuth secrets, raw
tokens, or a tenant identifier.

Each admitted OAuth client is bound to the promoted client evidence by a public,
canonical SHA-256 configuration digest. Its exact bytes are the UTF-8 domain
prefix `exomem-oauth-client-config:v1\0` followed by compact stable JSON with
sorted keys `admission_mode`, `client_id`, `platform`, sorted exact raw `redirect_uris`, and
`token_endpoint_auth_method: "none"`. The signed promotion envelope carries
that digest; no separate environment secret exists and there is nothing to
rotate. An operator registers the platform and selected pending/live artifact,
then enables only the matching digest. A missing or mismatched digest is not
authority for authorize, code exchange, refresh, continuations, or MCP.

The repository's paired fixture composes schema-isolated PostgreSQL admission,
OAuth issuance, lifecycle, deletion, and the fake provider/MCP seams. It is
local seam proof only and is never sufficient to promote a client artifact.
Promotion requires separately recorded, signed evidence from a clean real client
on **each platform being promoted**: native install, one OAuth authorization,
static discovery without infrastructure creation, seeded recall, citation,
governed capture, fresh-chat recall, lifecycle/revocation handling, and
same-owner attachment to one tenant/cell/volume. Do not represent a mocked route
or a test fixture as a client run.

Two gates live here and they are not the same gate.

The **admission gate** is a live cohort for the requesting client's own platform.
A Claude client is admitted on the strength of the Claude artifact; an OpenAI
client on the OpenAI artifact. Promoting a single platform is supported: omit the
OpenAI artifact and evidence, and the cohort goes live for Claude alone. Until
2026-08-18 this was implicitly a paired gate, which meant no Claude user could be
admitted until a real registered OpenAI `asdk_app_*` existed -- a coupling that
never described the requesting client and that blocked the invite-only alpha.

The **marketplace-launch gate** is the paired one, and it is unchanged: a real
registered OpenAI `asdk_app_*` artifact plus a clean-client, content-bearing
cross-client run remain external release gates before claiming public
two-platform support. When both platforms are promoted together, their evidence
must still name the same cohort -- the paired run, Exomem identity, and tenant
digests are compared and a mismatch refuses the promotion.

A single-platform promotion does not retire the other platform's artifact, but do
not read that as a later pairing being available: it is not. See "Promotion is
one-shot per candidate" above -- promotion retires the rollout assignment the
`cells` precondition requires, so adding the second platform to a live candidate
returns `precondition_failed` with every input present and correct, and enabling
it means a fresh candidate and a full new window for both platforms. This
paragraph previously described that pairing as "an ordinary promotion of that
artifact", which contradicted the section above and was wrong.

The promotion request expresses the choice by which artifacts it names. Omitting
`openaiArtifactId` promotes a Claude-only cohort; naming both promotes the pair.
A malformed OpenAI artifact id is refused rather than read as an omission, and so
is OpenAI evidence sent without an OpenAI artifact -- otherwise a mistyped id
would quietly foreclose ChatGPT on the candidate and report success.

### External hosted scheduler

Vercel Hobby rejects cron expressions that run more than once per day, so the
three frequent Exomem jobs are deliberately absent from `vercel.json`. Their
versioned source of truth is `ops/exomem-hosted-schedules.json`. The hosted K3s
platform release renders that contract as CronJobs which call the canonical
`https://substratesystems.io` origin with
`Authorization: Bearer <EXOMEM_HOSTED_SCHEDULER_SECRET>`:

- access delivery every minute;
- lifecycle and Paddle reconciliation every minute; and
- export garbage collection hourly at minute 17.

The scheduler receives only the active dedicated secret; it does not receive
`CRON_SECRET`, the receiver's optional previous secret, database, Paddle, cell,
or browser credentials. The versioned contract itself pins GET, redirect
rejection, 5-second connect/20-second total timeouts, `Forbid` concurrency, a
45-second starting deadline, a 30-second active deadline, two total attempts,
bounded job history, content-free attempt/outcome/duration/last-success metrics,
and alerts after 180 seconds without a due success or two consecutive failures.
The private alpha remains closed until rendered CronJobs match every field and
each route rejects both a bad bearer and the unrelated global `CRON_SECRET`.

Rotate the dedicated bearer with explicit overlap:

1. Generate a new active value without printing it. In Vercel, set the new value
   as `EXOMEM_HOSTED_SCHEDULER_SECRET` and the old value as
   `EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS`, then redeploy. Prove both values
   reach only the three Exomem hosted routes.
2. Update the SOPS-encrypted K3s scheduler Secret to the new active value, apply
   the platform release, and prove every scheduled route succeeds with content-free
   telemetry. Never copy the previous receiver value into K3s.
3. Remove `EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS` from Vercel and redeploy.
   Prove the old value returns 401, the active value succeeds, and unrelated cron
   routes still require `CRON_SECRET`.

Generate the control-plane key without printing raw bytes in shell history:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The provisioner, not the Vercel app, owns provider-specific volume and object
storage credentials. It must store exports under an opaque tenant scope using
envelope AES-256-GCM, verify archive and manifest SHA-256 values, and return only
the opaque reference and integrity metadata described below.

### Paid Paddle checkout, recovery, and reconciliation

Paddle is an operator/billing adapter, never a cell runtime dependency. During
this friends-only alpha, it charges only authenticated owners created by paid
operator invitations. Invite redemption creates the owner, tenant, Paddle
entitlement, browser session, and reserved allocation, but no lifecycle operation
and no provider resource. Home then creates or resumes a server-selected checkout
for the configured €5 monthly price. The browser cannot select a product, price,
tenant, environment, or return URL.

An authoritative active or trialing subscription event releases that reservation:
provider events release a reserved paid tenant into exactly one ordinary
`initial-provision` operation and attach that operation to the allocation in the
same database statement as event receipt and entitlement projection. A missing
allocation or live runtime target rolls the whole statement back so Paddle retries
remain useful. Duplicate and stale events create no second operation. Public
self-serve remains closed regardless of Paddle configuration.

An existing or newly created transaction return is accepted only when its exact transaction ID
and provider environment are already bound to the authenticated owner. Home may
complete that recovery path. A settled or canceled return clears or promotes
only the recorded binding, and never creates a replacement transaction. Keep the
stored environment and merchant API access available until every existing
transaction and paid subscription is resolved.

For existing paid records, preserve the shared Paddle destination at
`$EXOMEM_PUBLIC_BASE_URL/api/webhooks/paddle`, its `PADDLE_WEBHOOK_SECRET`, and
the `transaction.completed` plus subscription `created`, `activated`, `updated`,
`past_due`, `paused`, `resumed`, and `canceled` events. A coordinated secret
rotation must update the destination and deployment together or existing
deliveries will fail verification. Provider customer, subscription, transaction,
product, and price IDs stay in Substrate's control-plane tables; they are never
forwarded to a tenant cell.

## Provisioner contract

### D1 expand preflight and traffic freeze

Use the canonical Exomem deployment-lock pair from the reviewed `0.54.1`
composition. Its exact raw-byte SHA-256 is
`7eeac57b3457846d00974da0e4d8dd3ddb2819687634fc2cf70dd43d2c5a840c`;
the three-unit release set is `0.39.2/1`, `0.49.0/1`, plus `0.50.0/1`, with digest
`85cdcbac931f3aa9357bf59c5530a1ba73ce1c81176286aa2b56b421276bdd79`.
This is the already-completed outer-provisioner D1 expand gate, not the current
agent-profile release pin. Do not rerun it merely to roll a cell from
`0.57.2/v1` to `0.66.0/v4`; rerun it only when changing the outer provisioner
wire contract or when its own contraction/rollback procedure requires it.
Supply `DATABASE_URL` to the process from the approved secret channel without
placing it in argv or output, then run from this exact Substrate release:

```bash
npx tsx scripts/exomem-d1-expand-preflight.ts \
  --lock-pair /path/to/exomem/infra/contracts/exomem-hosted-deployment-lock-pair-v2.json \
  --lock-pair-sha256 7eeac57b3457846d00974da0e4d8dd3ddb2819687634fc2cf70dd43d2c5a840c
```

The command verifies canonical pair bytes, expand/contract equivalence, the
complete reviewed catalog digest, and that the current non-empty, fully resolved
routable/live/assigned/unfinished-v1 and retained-export release set is a subset
of that catalog inside one repeatable-read snapshot. A reviewed dormant rollback
unit may remain in the catalog; the distinct `0.54.1` forward target is not
injected into either legacy set. It then keeps the shared cohort advisory lock
held and prints only the pair hash, separate catalog/current set digests and pair
counts, and `status: "held"`. Leave that process connected while cutting
provisioner traffic to D1 and proving every catalogued v1 unit plus synthetic
v2. Assignment, binding-authority refresh, and promotion transactions remain
blocked behind the same lock.

If the current set is empty, unresolved, or contains an uncatalogued pair, the
command rolls back, unlocks, and emits only the bounded failure line. Do not
deploy D1: repair the authoritative state or regenerate and review the lock pair.
After the
dual-serving proof is complete and D1 is taking traffic, type the exact line
`release` on stdin. Only a reported `status: "released"` permits enabling
`EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED=true` for the fresh reviewer canary.

Every call is `POST {EXOMEM_PROVISIONER_ENDPOINT}/cells/{action}` with:

- `Authorization: Bearer <EXOMEM_PROVISIONER_CREDENTIAL>`;
- `Idempotency-Key: <operation/checkpoint key>`; and
- `X-Exomem-Provisioner-Protocol`, selected only from the lifecycle operation's
  persisted outer provisioner wire protocol.

The outer provisioner wire protocol is independent from the inner Hosted
runtime protocol. The v2 wire still targets Hosted runtime protocol `1` and
the existing private `/private/exomem/v1/...` routes. The binary default remains
v1 for rolling compatibility. A newly created operation uses v2 only when
`EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED` is exactly trimmed, case-normalized
`true`; missing, empty, malformed, and false values all select v1. For current
operations, `EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED=true` remains valid only
after the D1 dual-serving expand proof and reviewed lock pair are live. Outer
v2 carries the runtime target persisted on the lifecycle operation: a new
`0.66.0` reviewer rollforward carries `hosted-alpha-agent-v4`, while historical
operations retain their original v1 target.

Actions are `provision`, `health`, `rotate-credential`, `quiesce`, `resume`,
`stop`, `export`, `export-release`, `export-download`, `export-delete`, `restore`,
`seal`, `discard`, and `destroy`. Calls with
the same idempotency key and input must converge to the same result; reusing a
key with different input must fail.

The v1 Python/TypeScript interoperability corpus is byte-frozen at SHA-256
`ced714a5aa204a837e22cab831262cc0ae4766e44720b2896e61b8c157ddd3b5`.
The separate v2 corpus is SHA-256
`fe4daf1b190e8e4efc737a7197d8df73c28a8672bd8e331fc95dcabf339e0881`.
Together they exercise the real `HttpCellProvisioner` serializer/parser for all
14 requests, exact pending responses, every final proof (including void
results), and every content-free server error class. Regenerate only from the
companion Exomem source; do not hand-edit either copy.

`health` is binding proof, not a generic 200. It must return the expected cell
ID, protocol, release, authenticated-service state, mutation authority, read and
write admissions, and exact worker policy. For v2 it must additionally return
exactly the six-field `runtimeIdentity`: releaseVersion, protocolVersion, fixed
supported agentProfile, gatewayContractDigest, commandFingerprint, and
schemaDigest. Gateway, command, and schema observations are runtime evidence;
compatibility remains a local immutable catalog binding and is never accepted
from health. Substrate does not bind or route a candidate that fails any field.

Cell-scoped v2 calls carry a `runtimeTarget` constructed solely from that
operation's persisted target snapshot. Candidate IDs, assignment IDs,
compatibility digests, package/archive locks, plugin provenance, OAuth metadata,
and image references are never sent. `export-download`, `export-delete`, and
tenant `destroy` retain the operation's persisted wire protocol but are
target-free. Destructive cleanup/recovery must not manufacture or require live
readiness evidence.

The outer provisioner wire protocol is durably recorded on every lifecycle
operation. The deployed consumer accepts the exact v1 and v2 literals after
migration `0045`; retries use the stored literal even across a rollout and never
re-read the issuance flag. Strict v1 health is intentionally identity-less. A v1 response that carries
`contractIdentity` is a mixed envelope and fails closed. The sole
lower-assurance exception is an unexpired marketplace-reviewer tenant with its
exact reviewer assignment: it may bind with all four cell runtime observations
NULL. Its routable row is selected routing metadata, never observed runtime
identity, and it cannot be used to promote a cohort. Every promotion authority
cell requires a succeeded bound lifecycle proof and complete exact runtime
observations matching its operation target and catalog route.

`export` carries one exact product expiry in its idempotent request and must return non-empty opaque
`exportRef` and `releaseRef` values, 64-character lowercase
`archiveSha256` and `manifestSha256`, positive `archiveSize`,
`encryptionScheme: "envelope-aes-256-gcm"`, and `integrityVerified: true`.
The client always forwards an exact replay even after that expiry. The provider
returns the stored result when the key and canonical input already completed,
continues an already-accepted request, but rejects a brand-new expired request
with side-effect-free `EXPORT_REQUEST_EXPIRED` without creating an artifact.
Generic or malformed 422 responses remain `PROVISIONER_REJECTED`; Substrate
never infers expiry from status alone.
Substrate records the verified provider object before calling `export-release`;
the cell keeps its local artifact until that idempotent acknowledgement. Expired
provider objects are removed by the bounded hourly `exomem-export-gc` pass. If
the exact product expiry elapses while `export` is in flight, Substrate records
the object directly as deleting and moves the operation into the mandatory
`export-expired-release` checkpoint. Provider-pending responses and retryable
failures at that checkpoint continue past the ordinary attempt cap. Substrate
idempotently releases the cell-local artifact, then acknowledges that release
in a fenced transaction which clears the encrypted handle and opens a separate
restoration checkpoint. A previously running cell is resumed and must re-prove
exact readiness; an already-suspended cell is durably marked quiesced. Release,
resume, and readiness each run under their own lease and pending or retryable
responses remain mandatory past the ordinary attempt cap. Only after restoration
does Substrate record terminal `EXPORT_EXPIRED`; it never publishes the artifact
or retains an acknowledged cleanup handle.
`export-delete` must return `objectDestroyed: true` before the control plane
scrubs the encrypted reference and integrity metadata into a tombstone.
`export-download` returns an HTTPS URL expiring within 15 minutes. `destroy`
must prove `computeDestroyed`, `storageDestroyed`, and `keysDestroyed`; deletion
stays pending unless all three are true.

### Expired reviewer cleanup recovery

This is the one operator-only escape hatch for a reviewer-purpose tenant whose
immutable reviewer assignment expired or was ended through the exact existing
`fail-assignment` transition. It accepts only either an exact `provision` or
`restore` stranded in `candidate-cleanup`, or an exact `provision` that already
succeeded at `bound` with the tenant's sole cell active, routable,
provider-backed, desired-running, and `CELL_READY`, and with its full observed
runtime identity and routable observation matching the source target. The
successful-bound source remains
`succeeded/bound`; recovery never rewrites history to make it look unfinished.
This is not a force-delete. Keep the scheduler suspended while investigating
and never use a tenant, cell, owner, provider operation, or capacity identifier
as input.

Call the authenticated contracts endpoint with only the opaque source operation
UUID and the current expected fence, first using
`preflight-recover-expired-reviewer-cleanup`, then once with
`recover-expired-reviewer-cleanup`. The preflight is read-only and returns only
`eligible` plus a request ID. A refusal is deliberately non-diagnostic: stop,
inspect the exact state privately, and do not retry with altered selectors.
When the exact assignment has not yet expired, use the existing authenticated
`fail-assignment` transition for that assignment UUID and its current version
before this preflight; that transition ends the assignment without extending its
immutable expiry. Do not use this recovery for any other failed assignment.
The mutation returns only `enqueued` or `replayed`, an opaque delete operation
ID, and a request ID.

Before accepting the successful-bound branch, preflight also requires the
source cell to equal `tenant.bound_cell_id`, exactly one non-deleted cell, an
expired or terminal-failed reviewer-purpose assignment with matching runtime
identity, and no live bootstrap authority, assignment, lease, or conflicting
current-fence lifecycle operation. Residual tenant-bound credentials, sessions,
transfers, and OAuth grants do not make the tenant ineligible: recovery must see
and revoke their complete lineage inside its locked transaction. Any
customer, restore-success, stale-fence, multi-cell, non-ready, non-routable, or
other bound state must refuse without mutation.

The recovery transaction blocks the OAuth account, revokes Hosted sessions,
access tokens, transfers, reviewer credentials/bootstrap authority, outstanding
reviewer invites, and OAuth authority, gates entitlement and exports, and
creates the normal target-free tenant `delete` operation at the next fence. It
serializes reviewer credential/session creation, magic-link redemption, and
transfer-grant mint/consume before taking that gate; session lookup and transfer
consumption also reject deletion-pending, deleted, or account-blocked tenants. It
does not edit provider state, manufacture a provider proof, release capacity,
or mark the tenant/cell deleted. A retry is allowed only as the exact replay of
the superseded unfinished source or unchanged successful-bound source at the
old fence and the one derived-key delete at old-fence-plus-one.

After the mutation returns `enqueued` or `replayed`, run bounded authenticated
reconcile passes for that opaque delete operation. Do not mark the cleanup done
from control-plane state alone. Confirm the provisioner proved compute, storage,
and keys destroyed; the tenant and cell reached deleted state; the routable
observation is absent; its capacity allocation and pool counters are released;
and no Hosted session, access token, transfer, reviewer credential/bootstrap,
OAuth grant/family/token, or unconsumed reviewer invite remains usable. Only
after all of those checks may normal scheduling resume and a fresh reviewer
ceremony begin. Provider-backed deletion is irreversible; retain the audit and
operation receipts.

### Terminal reviewer delete replay

Use this narrower recovery only for the one provider-proven reviewer deletion
that is already terminal as `failed_terminal` / `LIFECYCLE_MAX_ATTEMPTS` at
checkpoint `destroyed`. Keep the scheduler suspended while checking the exact
state. Do not use it for another tenant, a new delete, an earlier checkpoint,
or a capacity repair.

Call `POST /api/exomem/admin/contracts` with exactly one of these bodies,
first the preflight and then one recovery request:

```json
{
  "action": "preflight-recover-terminal-reviewer-delete",
  "operationId": "<uuid>",
  "expectedFence": 2
}
```

```json
{ "action": "recover-terminal-reviewer-delete", "operationId": "<uuid>", "expectedFence": 2 }
```

Both responses are content-free: preflight returns only `eligible` and a
request ID; recovery returns only `enqueued` or `replayed`, the opaque operation
ID, and a request ID. A refusal is non-diagnostic: stop and inspect privately;
never try altered selectors.

The control accepts only the existing target-free delete (`cell_id` and
`expected_previous_cell_id` are both `NULL`), its current fence, the persisted
`destroyed` checkpoint as provider proof, and the exact
`confirmed-deletion-<token-id>` idempotency identity. That token must be a
consumed `deletion_confirmation` token bound to the same tenant and its
immutable owner; an expired-reviewer cleanup hash or audit cannot substitute
for it. The superseded source must bind the sole unbound provider-free cell.
It also requires the exact consumed bootstrap/candidate contract lineage,
uncertain allocation with checked counters, and no unfinished or live
reviewer/OAuth authority. It reopens the same operation once at
`destroyed`; it does not call the provider, create a delete, alter capacity, or
alter the checkpoint, fence, or idempotency key.
After one bounded reconcile, verify that the same operation is
`succeeded/destroyed`, the tenant and cells are deleted, uncertain capacity was
released by the normal finalizer, all live authority is scrubbed, and the
consumed bootstrap invite plus revoked outcome session remain retained.

After the one invocation, run one bounded authenticated
`/api/cron/exomem-reconcile` pass. It resumes only the current local finalizer
from the already-persisted `destroyed` checkpoint and makes zero provider calls.
Verify the same operation is `succeeded/destroyed`, the tenant and cells are
deleted, uncertain capacity was released by that finalizer, and the consumed
bootstrap invite plus revoked outcome session remain retained.
Only then resume normal scheduling, prepare a fresh staged candidate and a
fresh reviewer bootstrap, and issue fresh reviewer authority. Never reopen the
expired source operation or reuse its client, credential, assignment, or
bootstrap authority.

### Correct a cell whose runtime moved out of band

Symptom: a lifecycle operation is `failed_terminal` / `PROVISIONER_REJECTED` at an
early checkpoint after one attempt, and the provisioner's own `operations` table has
**no row for it at all**. That combination means the request was refused in admission
before it was ever persisted, and the usual cause is a runtime that was upgraded
without the control plane's record following it.

The mechanism is worth stating plainly, because nothing in the wire response says it.
A cell's recorded `release_version` pins the `runtimeTarget` of every operation the
tenant can mint, and the provisioner admits a v2 request only when that target is
byte-equal to the deployment lock's active runtime. Once the two disagree the cell
cannot be quiesced, sealed, or destroyed, and no request shape escapes it — health
carries the same stale target. Retrying is pointless; the operation is terminal for a
reason.

Confirm the divergence against the cluster before correcting anything. The control
takes your word that the runtime already moved, so that word has to be earned:

- read the serving pod's image in the cell namespace, and
- compare it with `components.runtime.image` in the provisioner's deployment lock
  (`$EXOMEM_PROVISIONER_DEPLOYMENT_LOCK_PATH`), and
- confirm the lock's `runtimeTarget` matches a cataloged candidate in Substrate on
  release, protocol, command fingerprint, schema digest and compatibility digest.

If the image does _not_ match the lock, stop: the cell is diverged in some other
direction and this control is the wrong tool.

Then call `POST /api/exomem/admin/contracts`, preflight first:

```json
{
  "action": "preflight-correct-diverged-cell-release",
  "cellId": "<uuid>",
  "candidateId": "<uuid>",
  "expectedCurrentRelease": "<stale release>",
  "expectedFence": 2
}
```

```json
{
  "action": "correct-diverged-cell-release",
  "cellId": "<uuid>",
  "candidateId": "<uuid>",
  "expectedCurrentRelease": "<stale release>",
  "expectedFence": 2
}
```

`expectedCurrentRelease` is the release the cell records _now_, not the one it should
record. It exists so a ticket written before somebody else corrected the same cell
refuses instead of moving it twice.

The control moves the cell's recorded release and its four observed digests onto the
candidate's identity, moves the routable observation with it, and installs one active
30-minute assignment on that candidate. It installs the assignment itself rather than
leaving it to `create-assignment` because the two are one fact: a delete derives its
target from the active assignment matched against the cell's recorded identity, so
correcting either alone leaves the tenant with no derivable target and a worse stall
than the one being repaired. Ordinary activation is not reachable here — it runs only
from a succeeding provision, which is exactly what a diverged cell cannot do.

It refuses, content-free, unless the cell is the tenant's only live cell, the tenant is
reviewer-purpose at the stated fence, the candidate is cataloged and genuinely differs
from what the cell records, a terminal assignment already exists for that tenant on
that candidate (it is the only source of the gateway digest — the control never
composes one), nothing is in flight, and no assignment is live. A refusal is not a
diagnosis: inspect privately, never retry with altered selectors.

It never calls the provider and never touches capacity. Re-issuing the same request
after it succeeds returns `replayed` with the same assignment.

Afterwards, confirm the recorded release matches the lock, then re-issue the lifecycle
operation that was stuck. The assignment expires in 30 minutes, so do the re-issue in
the same sitting.

### Supersede a delete the deployment lock can never admit

Correcting a diverged cell does **not** unstick its deletion, and the previous
section should not be read as implying it does. A lifecycle operation copies its
target into `target_*` columns when it is created, and the reconciler builds the
provisioner request from the operation rather than the cell
(`runtimeTarget: this.#runtimeTarget(operation)`). So an operation created before
a runtime moved keeps presenting the release the lock already refused, whatever
the cell underneath it now says. Reopening it re-sends the same rejection, and no
fresh delete can be minted either: `consumeDeletionConfirmationAtomic` accepts
only `provisioning`, `active` or `suspended`, never `deletion_pending`.

The escape is that tenant destruction has a shape admission cannot reject. A
target-free delete carries `cell_id` and every `target_*` column NULL, so there
is no `runtimeTarget` to compare. This control restores the tenant to it.

Preflight first, then supersede:

```json
{
  "action": "preflight-supersede-stranded-cell-delete",
  "operationId": "<uuid>",
  "expectedFence": 2
}
```

```json
{ "action": "supersede-stranded-cell-delete", "operationId": "<uuid>", "expectedFence": 2 }
```

It refuses, content-free, unless the pinned operation is a delete that is
`failed_terminal` with `PROVISIONER_REJECTED` **at checkpoint `local-gated`**,
unleased, on wire v2, carrying a cell and a target candidate, at a fence the
tenant also holds; and unless the tenant is reviewer-purpose, deletion-pending,
desired-deleted, holds exactly one live cell, and has nothing else unfinished.

The checkpoint clause is the safety boundary, not a formality. `local-gated` is
the last checkpoint before the first provider call, so an operation sitting there
provably has no destruction in flight. Past it the provider may hold partial
state that the control plane cannot see, and the control refuses rather than
guess. Do not widen it.

On success the tenant fence advances once, the pinned operation becomes
`DELETION_SUPERSEDED`, any live rollout assignment is ended, and one target-free
delete is enqueued at the new fence. Then run the ordinary reconcile and confirm
the replacement reaches `succeeded`, the cell is `deleted`, its routable
observation is gone, and the capacity slot is released. The cell is still cleaned
up despite the operation naming no cell, because `markCellState` matches every
cell of the tenant when deleting.

## Revoke historical self-serve invitations

Before enabling the €5 price, check for any historical self-serve invite that
could still be redeemed. The public route being `410` prevents new rows; it does
not revoke an old bearer already delivered by email.

```sql
SELECT count(*) AS outstanding_historical_self_serve_invites
FROM exomem_invites
WHERE self_serve
  AND consumed_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > now();
```

If the count is nonzero, stop the rollout, review the opaque invite IDs, and
revoke only that exact set in one transaction. Preserve the rows for audit:

```sql
BEGIN;
SELECT id
FROM exomem_invites
WHERE self_serve
  AND consumed_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > now()
FOR UPDATE;

UPDATE exomem_invites
SET revoked_at = now()
WHERE self_serve
  AND consumed_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > now()
RETURNING id;
COMMIT;
```

Run the count again and require zero. Do not delete or rewrite the historical
self-serve invite records.

## Issue an invite

Open `/exomem/operator` directly; it is deliberately absent from public
navigation and the sitemap. Paste `EXOMEM_ADMIN_TOKEN` into the page. The bearer
is held only until refresh or **Lock** and is never placed in browser storage.
The page shows hard storage/runtime reservations, outstanding paid invitations,
and remaining paid invite headroom.

Enter one email and leave **Paid — €5/month** selected. Paid is the default after
every send. Complimentary access is a separate selection and requires its own
confirmation. The page refreshes capacity after successful delivery and never
shows the plaintext invite token.

The authenticated API remains the non-browser fallback. Keep the operator token
out of logs and chat transcripts:

```bash
curl --fail-with-body \
  -X POST "$EXOMEM_PUBLIC_BASE_URL/api/exomem/admin/invites" \
  -H "Authorization: Bearer $EXOMEM_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"email":"invitee@example.com","source":"paid"}'
```

The response contains only an opaque invite ID and request ID. The token is sent
by Brevo in the URL fragment, so it is not placed in request logs. Paid redemption
burns the invite atomically and creates an `awaiting_checkout` Paddle entitlement
and hard reservation without queuing provisioning. The owner sees the €5 monthly
checkout on Home. Only verified payment queues provisioning. Complimentary
redemption retains the existing behavior and queues provisioning immediately.

For the first controlled paid invitation, prove all of the following before
inviting another person:

1. redemption creates one reserved allocation with `operation_id IS NULL`, one
   `awaiting_checkout` entitlement, and no provider resource;
2. Home opens only the server-selected €5 transaction and binds its exact Paddle
   environment and transaction reference;
3. verified active/trialing projection creates exactly one `initial-provision`
   operation and attaches it to the reserved allocation;
4. replaying the same delivery and reconciling the subscription creates no
   second operation; and
5. the external scheduler advances `preparing` to `ready` only after full private
   readiness proof. Do not manually mark a tenant active.

### Sandbox and controlled production proof

Run the complete paid path against a disposable preview deployment, isolated
verification database, Paddle sandbox product/€5 price, and sandbox webhook
destination first. Use Paddle's sandbox checkout, then require the five database
and readiness facts above. Deliver the same webhook twice and send one older
subscription update; require one operation, one applied receipt, one duplicate
disposition, one stale disposition, and no Endstate subscription change.

Only after that proof is green, set the production Exomem product and existing €5
price, redeploy, and issue exactly one controlled production paid invitation.
Redeem it in a clean browser, complete the real checkout, wait for `ready`, perform
one capture/recall round trip, and confirm the Paddle customer portal opens for
that owner. Redact email, tenant, provider, and transaction identifiers from the
proof record. Do not issue the next friend invitation until this one has converged
or has been deliberately stopped and accounted for.

## Marketplace reviewer access

Reviewer access is a temporary, operator-controlled OAuth path for a provider
reviewer. It is not public provisioning, ordinary username/password sign-in, or
an alternative customer admission path. Keep
`EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED` unset until every preparation step
below is complete. Never put a real reviewer email, owner ID, tenant ID,
credential, fixture content, or provider handoff in this repository, a command
history, or an application log.

1. Create a **new** dedicated owner through the authenticated invite endpoint
   with `marketplaceReviewerPurpose: true`. Use a controlled delivery address
   and redeem it through the ordinary Hosted OAuth path. The purpose marker is
   written only when that first tenant is created and is immutable. A reviewer
   invite cannot reuse an ordinary tenant, and an ordinary invite cannot reuse a
   reviewer-purpose tenant; do not attempt to relabel an existing customer.
2. Wait for the dedicated tenant's ordinary entitlement and cell readiness.
   The invite redemption creates temporary ordinary setup access; use it only
   to seed the versioned, generic marketplace fixture through the normal
   governed Exomem MCP/write flow, never by writing directly to the
   control-plane database. Record the fixture version and SHA-256 payload
   digest in the operator secret record; retain content-bearing proof only in
   the native client acceptance workflow.
3. With the operator bearer, create a provider-specific credential through
   `POST /api/exomem/admin/reviewer-access`. Supply the prepared owner and
   tenant IDs, `openai` or `anthropic`, the fixture version/digest, and a bounded
   future expiry from secure operator state. The response returns generated
   username/password plaintext once with `no-store`; copy it directly into the
   approved provider handoff or secret manager. Issuing the credential
   atomically seals the dedicated reviewer tenant by revoking its temporary
   ordinary setup sessions, pending authorization state, grants, codes, and
   token graph. Status reads never return either plaintext value. Do not share
   the credential before this sealing step completes.
4. Set `EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED=true`, redeploy, and use a
   clean provider client to begin the normal authorization flow. The reviewer
   form is valid only inside that OAuth continuation; its credential provider
   must match the trusted provider client. Confirm the explicit consent step,
   code exchange, refresh, and MCP read/write review cases against the seeded
   generic fixture. Capture only protocol metadata, request IDs, fixture digest,
   and pass/fail evidence.

To rotate, repeat the authenticated create request for the same provider with a
new bounded expiry. Rotation atomically revokes the old credential and its
tagged browser sessions, pending authorizations, codes, grants, token families,
refresh tokens, and access tokens; it does not block the account, delete the
tenant, or provision anything. To revoke without replacement, call
`DELETE /api/exomem/admin/reviewer-access` with only the provider selector and
the operator bearer. Repeating either revocation is safe. Credential expiry is
also enforced at session resolution, authorization confirmation, token exchange,
refresh, and MCP token lookup, so do not rely on a browser cookie remaining
present as evidence of access.

For a suspected reviewer credential disclosure, first disable the feature flag
and redeploy, then revoke that provider credential. Preserve only the request
ID, provider class, fixture digest, and stable outcome code for incident
evidence. Do not paste submitted credentials, username digests, user/tenant
identifiers, fixture content, or detailed authentication failures into tickets
or logs. Reissue a credential only after checking the dedicated tenant's
purpose, readiness, fixture digest, and clean-client review state.

## Recovery and routine operations

Lifecycle operations are durable and idempotent. Enqueue one operation with a
stable operator-selected key; then let the K3s-scheduled
`/api/cron/exomem-reconcile` call advance it. Never call a private cell directly
to work around a stuck checkpoint.

The same cron also reconciles due Paddle-backed entitlements independently of
lifecycle work. Each eligible subscription is durably scheduled, claimed with a
30-second exclusive lease, and checked no more than once per successful six-hour
cadence. Failures retry from one minute with exponential backoff capped at six
hours; overlapping cron calls use `SKIP LOCKED`, and unstarted claims are
released. The Paddle request inherits the remaining eight-second cron budget.
If eligible paid rows exist but the Paddle product/API configuration disappears,
provider provenance is unresolved, or a stored reference belongs to a different
environment, the cron returns a stable 503 before any Paddle call instead of
silently skipping or guessing. A tenant that enters deletion while a check is in
flight records the reconciliation as ignored and cannot have its billing
projection reopened.

- **Provisioning recovery:** inspect only tenant/operation IDs, checkpoint,
  attempt count, next-attempt time, and stable error code. Fix the provisioner or
  release mismatch, then allow the retry lease to run. A terminal configuration
  mismatch needs a new corrected operation; never bind the failed candidate.
- **Suspend:** enqueue `suspend` for the currently bound cell. The local routing
  gate closes before the provider call. A suspended tenant can read/export only
  according to its entitlement and cannot be silently routed elsewhere.
- **Resume:** enqueue `resume`. Routing reopens only after the exact cell again
  proves readiness.
- **Credential rotation:** enqueue `rotate_credential`. Rotation stages an
  overlapping credential, verifies it, promotes the encrypted control-plane
  copy, and only then finalizes the old credential.
- **Export:** the owner uses Home. The workflow quiesces, obtains and records a
  verified encrypted export, acknowledges release of the cell-local artifact,
  resumes only if the tenant was previously running,
  and exposes a short-lived owner-only download. Retrying returns the same
  operation/export. A lost release acknowledgement retries the same release key
  without creating or uploading another export.
- **Restore:** select one of that tenant's non-expired exports. Restore creates a
  durable same-tenant pin before GC can claim the object, creates a replacement
  cell, and keeps the old cell bound until the candidate proves
  identity, protocol, release, mutation authority, and worker policy. A failed
  restore leaves the old cell untouched.
- **Deletion:** Home sends a fresh one-use email confirmation. Consumption
  immediately closes routing and revokes Exomem sessions, invites, access
  tokens, transfers, entitlement, and export downloads. It never deletes the
  shared `users` row or Endstate data. Checkout binding serializes with deletion.
  Paid accounts cancel the exact pending transaction in its stored environment,
  or discover and cancel its subscription if checkout completed concurrently.
  Cleanup remains available when the sale price is disabled or rotated. A 404 is
  not cancellation proof because it can indicate the wrong Paddle account; keep
  deletion pending. One atomic transaction compares the complete billing
  fingerprint, marks termination, scrubs the dead Paddle references, and
  advances the leased deletion checkpoint, so webhook races cannot slip between
  proof and cell destruction; complimentary accounts make no Paddle call.
  Completion waits for full provider destruction proof.

## Two-cell isolation drill

Run this before the first real invite and after gateway, provisioner, or cell
protocol changes:

1. issue two complimentary invites to controlled addresses and accept both;
2. wait for two distinct ready cell IDs/provider references;
3. capture `ALPHA-<random>` in one Home and `BRAVO-<random>` in the other using
   the same title and same browser-visible retry key;
4. recall and download from each account; verify neither response, error, export,
   or operational event contains the other sentinel;
5. retry both captures and one transfer; verify no duplicate mutation;
6. suspend Alpha and prove Alpha writes stop while Bravo capture/recall remains
   available; resume Alpha and wait for readiness;
7. export Alpha, restore it into a replacement Alpha cell, and prove canonical
   bytes return while derived indexes can rebuild;
8. rotate Alpha's credential and prove the old credential can no longer route;
9. delete Alpha through emailed confirmation and wait for compute/storage/key
   destruction proof; and
10. prove Bravo is still ready and can capture/recall its sentinel.

Repository gates exercise this protocol deterministically:

```bash
npm test
npx tsc --noEmit
npm run build
npm run format:check
npm run openspec:validate
```

## Incident isolation

If one tenant reports wrong or unavailable content, close that tenant's local
routing gate first. Do not restart, suspend, rotate, or reroute any other cell.
Compare the authenticated owner-to-tenant-to-cell mapping with the cell's private
readiness proof and the gateway request ID. There is intentionally no
alternate-cell fallback.

Operational logs may contain only opaque user/tenant/cell/operation/request IDs,
command name, release/protocol, duration, coarse byte/count buckets, and stable
status code. Never log request/response bodies, email, title, query, path,
filename, token, grant, credential, private endpoint, Paddle ID, or export
storage reference.

For a suspected confused-deputy or credential incident: suspend the affected
tenant, revoke its sessions/transfers, rotate that cell credential, verify the
mapping and readiness contract, then resume. A cross-tenant sentinel is a stop-
ship incident: keep routing closed and preserve only content-free audit evidence.

## Rollback

### Hosted contract cohort rollback

Use the authenticated `/api/exomem/admin/contracts` control only. Its status
view is content-free: candidate state, observed contract identity, the exact
`routableSetDigest` required as `expectedRoutableCellDigest` for promotion,
routable count, `routableObservationFresh`, and the latest lifecycle target.
Promotion derives fresh strict outer-v2 health from every current routable cell
using only persisted lifecycle targets and cell inputs; a timeout, malformed
response, target mismatch, or route-set change fails closed. Supply the status
digest unchanged, never a guessed digest. `expire-canary-authority`
reports expired assignment and stage counts, revoked credential count, and
whether the bounded sweep is drained. Create stages and assignments only for
the reviewer-purpose tenant; expiry and versioned failure are terminal and
revoke dependent internal-canary lineage. `begin-export` and `begin-restore`
pin server-selected lifecycle targets under the cohort lock; restore accepts an
available export ID, never caller-supplied cell or contract identity.

Contraction is an immutable contract-lock deployment, not an environment-flag
flip. Before it, read `contractionReadiness` from that status view. It contains
only `unfinishedV1Operations`, `retainedV1Exports`, and `ready`:
`unfinishedV1Operations` counts stored-v1 lifecycle operations except
`succeeded` and `failed_terminal`; `retainedV1Exports` counts every non-deleted
export whose originating lifecycle operation stored v1. Do not deploy the
contract lock until both counts are zero. This includes v1-origin export download
and export-GC continuations: a completed export operation can still require the
v1 provisioner until its retained export is deleted. Keep expand mode until both
counts are zero; never rewrite a stored protocol to make the status appear
drained.

Emergency demotion stops a live unit; it is not rollback. To re-import the
current `0.66.0` catalog unit as a fresh pending candidate, use
`{ "action": "import-agent" }`. The retained control remains available only to
reconstruct immutable historical catalog units for audit and pre-v4 recovery
work:

```json
POST /api/exomem/admin/contracts
{ "action": "import-retained-agent", "sourceRelease": "0.34.0" }
```

`sourceRelease` for `import-retained-agent` is limited to `0.34.0`, `0.35.0`,
`0.39.2`, `0.49.0`, `0.50.0`, or `0.54.1`; it must never name the current
`0.66.0`. Retiring a release ships its retained fixture so live cells keep
routing, but does not widen this control -- `0.57.2` and `0.63.1` both have
retained fixtures and neither is importable here. After
the v4 profile cutover these retained v1 rows cannot receive new assignments,
authorize credentials, satisfy routable authority, or be promoted. Never revive
retired candidates, stages, assignments, client artifacts, or historical
evidence. Before v4 promotion, rollback means retiring the pending v4 candidate
and leaving the live v1 cohort untouched. After a cell rollforward, recover by
the verified restore path; never reverse-roll the cell to a retained v1 release.
The historical 0.24 full-contract / 0.34 agent split is not a coherent unit and
cannot be routed or promoted.

Application rollback is safe because the Exomem migrations are additive, but
export operations must first be fenced and drained. Stop new invites and export
requests, then wait until no active export has `export_request_started = true`
at checkpoint `quiesced`; the current release must finish those compatibility
replays before an older release can safely run. Keep affected tenant routing
closed, deploy the prior Substrate release, and pin cells to its compatible
protocol/release. Preserve durable account blocks and revoke affected OAuth
token families. Leave the additive schema in place; never down-migrate, copy,
or rewrite live vault content.

For marketplace reviewer rollback, disable
`EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED` first and redeploy, then revoke
each active provider reviewer credential through the authenticated operator
endpoint. Verify that the reviewer session, pending authorization, code, grant,
family, refresh-token, and access-token lookups are rejected. Leave the
dedicated reviewer-purpose tenant and additive schema intact; rollback never
deletes the tenant, blocks its owner, or converts it into a customer tenant.

Before a cell release rollback, quiesce and verify an export. Start a replacement
cell on the prior compatible image, restore into an empty volume, require full
readiness, then atomically swap the binding. Keep the prior cell sealed but not
destroyed until the replacement passes recall and sentinel-isolation checks.

For paid-alpha rollback, stop issuing paid invitations, remove only
`EXOMEM_PADDLE_PRICE_ID`, and redeploy. Removing only `EXOMEM_PADDLE_PRICE_ID`
stops new checkout without reopening public admission or disturbing the public
`410` route. Keep the matching Paddle API key, webhook secret, client environment,
product, and catalog environment until every existing transaction and paid
subscription is resolved; portal, reconciliation, and deletion deliberately fail
closed if that configuration is removed too early. Existing paid subscriptions
and complimentary accounts continue normal memory operations. Do not revoke,
release, or delete a paid tenant merely because new checkout was disabled.

## Honest privacy and ownership boundary

Canonical Markdown, original media, governed history, and registered portable
review state belong to the user and are included in verified exports. Search
indexes, model caches, locks, credentials, provider logs, and temporary files are
rebuildable or disposable and are excluded.

This is encrypted hosted storage, not zero-knowledge search. The cell must see
plaintext to search and serve it, and a tightly controlled operator could access
the running cell. The product promise is tenant isolation, encryption at rest
and in transit, minimal operational metadata, verified portability, and explicit
destruction—not an end-to-end-encryption claim the architecture cannot support.
