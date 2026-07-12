# Exomem Hosted Alpha — Operator Runbook

This runbook covers the invite-only, complimentary alpha. Substrate is the
public account, entitlement, routing, and lifecycle control plane. Every tenant
is routed to one private Exomem cell with its own vault, state, logs, service
credential, and provider resource. A cell never receives email, browser
cookies, Paddle identifiers, database credentials, or another tenant's address.

The application side is provider-neutral. Real invitations require an HTTPS
provisioner that implements `exomem-cell-provisioner.v1`; until that endpoint is
configured, invite redemption is safe but the tenant remains in `preparing`.

## Alpha launch gates

The complimentary alpha does **not** require Paddle or a price. It does require:

1. migration `0017_exomem_hosted_service.sql` applied to the production Neon
   database;
2. an Exomem `0.19.1` cell image exposing private protocol `1`;
3. a provisioner endpoint with persistent, tenant-isolated volumes and encrypted
   export storage;
4. all required Substrate secrets below;
5. the minute reconciliation cron reaching `/api/cron/exomem-reconcile`; and
6. a two-cell isolation/export/deletion drill before a real invite is sent.

Paid launch remains deliberately disabled until an Exomem price, checkout
domain, terms/tax review, live webhook, and cancellation drill are approved.

## Substrate configuration

Set secrets in every Vercel environment that can execute an Exomem route, then
redeploy. Never reuse a cell credential as any control-plane secret.

| Variable                                  | Requirement                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                            | Neon/Postgres connection used by migrations and product-scoped rows.                                                                                                                     |
| `EXOMEM_PUBLIC_BASE_URL`                  | Required production HTTPS origin used in invite, magic-link, and deletion email links. Credentials, query, fragment, and non-root paths are rejected. Development HTTP is loopback-only. |
| `EXOMEM_ADMIN_TOKEN`                      | At least 32 random bytes, known only to operators; protects invite issuance.                                                                                                             |
| `EXOMEM_CONTROL_PLANE_KEY`                | Exactly 32 random bytes encoded as unpadded base64url; encrypts private endpoints, cell credentials, and export references.                                                              |
| `EXOMEM_PROVISIONER_ENDPOINT`             | Private HTTPS base URL implementing the provisioner contract. URLs containing credentials or using HTTP are rejected.                                                                    |
| `EXOMEM_PROVISIONER_CREDENTIAL`           | At least 32 characters; authenticates Substrate to the provisioner.                                                                                                                      |
| `EXOMEM_PROVISIONER_TIMEOUT_MS`           | Optional `100..30000`; default `5000`.                                                                                                                                                   |
| `EXOMEM_CELL_PROTOCOL_VERSION`            | `1` for this alpha.                                                                                                                                                                      |
| `EXOMEM_CELL_RELEASE_VERSION`             | Exact deployed Exomem release, initially `0.19.1`. Readiness must echo it.                                                                                                               |
| `EXOMEM_CELL_WORKER_COUNT`                | `0` for alpha.                                                                                                                                                                           |
| `EXOMEM_CELL_SEMANTIC_WORKERS`            | `false` for alpha.                                                                                                                                                                       |
| `EXOMEM_CELL_MEDIA_WORKERS`               | `false` for alpha.                                                                                                                                                                       |
| `EXOMEM_EXPORT_TTL_HOURS`                 | Positive integer; default `24`. Provider download URLs are separately capped at 15 minutes.                                                                                              |
| `CRON_SECRET`                             | Shared Vercel cron bearer secret; the reconcile route fails closed if absent.                                                                                                            |
| `BREVO_API_KEY`                           | Delivers invite, magic-link, and deletion-confirmation email.                                                                                                                            |
| `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME` | Optional verified sender overrides.                                                                                                                                                      |

Rate-limit bucket identifiers are domain-separated HMACs under the control-plane
key, never plain hashes of email or IP addresses. Buckets older than the longest
configured window plus a one-hour margin are pruned in bounded batches by the
access-delivery cron.

Generate the control-plane key without printing raw bytes in shell history:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

The provisioner, not the Vercel app, owns provider-specific volume and object
storage credentials. It must store exports under an opaque tenant scope using
envelope AES-256-GCM, verify archive and manifest SHA-256 values, and return only
the opaque reference and integrity metadata described below.

### Optional Paddle sandbox configuration

Paddle is an operator/billing adapter, never a cell runtime dependency. The
sandbox product created for this change is `pro_01kxatbjfrehbp0sxbjefcacqs`.
Keep `EXOMEM_PADDLE_PRICE_ID` unset for complimentary alpha; that makes paid
checkout fail closed while Home and every memory operation continue to work.

| Variable                            | Complimentary alpha                       | Paid sandbox drill               |
| ----------------------------------- | ----------------------------------------- | -------------------------------- |
| `PADDLE_ENVIRONMENT`                | optional                                  | `sandbox`                        |
| `PADDLE_API_KEY`                    | optional                                  | sandbox API key                  |
| `PADDLE_WEBHOOK_SECRET`             | optional unless shared webhook is enabled | sandbox notification secret      |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`   | optional                                  | sandbox client token             |
| `EXOMEM_PADDLE_CATALOG_ENVIRONMENT` | optional                                  | `sandbox`                        |
| `EXOMEM_PADDLE_PRODUCT_ID`          | optional                                  | `pro_01kxatbjfrehbp0sxbjefcacqs` |
| `EXOMEM_PADDLE_PRICE_ID`            | **unset**                                 | exact approved sandbox price ID  |

Sandbox and production identifiers are never interchangeable. The adapter
checks the API-key prefix, selected environment, catalog environment, product,
and price before creating a transaction.

## Provisioner contract

Every call is `POST {EXOMEM_PROVISIONER_ENDPOINT}/cells/{action}` with:

- `Authorization: Bearer <EXOMEM_PROVISIONER_CREDENTIAL>`;
- `Idempotency-Key: <operation/checkpoint key>`; and
- `X-Exomem-Provisioner-Protocol: exomem-cell-provisioner.v1`.

Actions are `provision`, `health`, `rotate-credential`, `quiesce`, `resume`,
`stop`, `export`, `export-release`, `export-download`, `export-delete`, `restore`,
`seal`, and `destroy`. Calls with
the same idempotency key and input must converge to the same result; reusing a
key with different input must fail.

`health` is binding proof, not a generic 200. It must return the expected cell
ID, protocol, release, authenticated-service state, mutation authority, read and
write admissions, and exact worker policy. Substrate does not bind or route a
candidate that fails any field.

`export` must return non-empty opaque `exportRef` and `releaseRef` values, 64-character lowercase
`archiveSha256` and `manifestSha256`, positive `archiveSize`,
`encryptionScheme: "envelope-aes-256-gcm"`, and `integrityVerified: true`.
Substrate records the verified provider object before calling `export-release`;
the cell keeps its local artifact until that idempotent acknowledgement. Expired
provider objects are removed by the bounded hourly `exomem-export-gc` pass.
`export-delete` must return `objectDestroyed: true` before the control plane
scrubs the encrypted reference and integrity metadata into a tombstone.
`export-download` returns an HTTPS URL expiring within 15 minutes. `destroy`
must prove `computeDestroyed`, `storageDestroyed`, and `keysDestroyed`; deletion
stays pending unless all three are true.

## Issue an invite

Issue complimentary invites one at a time and keep the operator token out of
logs and chat transcripts:

```bash
curl --fail-with-body \
  -X POST "$EXOMEM_PUBLIC_BASE_URL/api/exomem/admin/invites" \
  -H "Authorization: Bearer $EXOMEM_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"email":"invitee@example.com","source":"complimentary"}'
```

The response contains only an opaque invite ID and request ID. The token is sent
by Brevo in the URL fragment, so it is not placed in request logs. Redemption
burns the invite atomically, creates only an Exomem product session, creates a
complimentary entitlement, and queues provisioning. Replays and email override
attempts fail.

After acceptance, the owner sees `preparing` while status polling and the cron
advance the durable operation. `ready` is shown only after full private readiness
proof. Do not manually mark a tenant active.

## Recovery and routine operations

Lifecycle operations are durable and idempotent. Enqueue one operation with a
stable operator-selected key; then let `/api/cron/exomem-reconcile` advance it.
Never call a private cell directly to work around a stuck checkpoint.

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
  shared `users` row or Endstate data. Paid accounts must prove subscription
  cancellation before cell destruction; complimentary accounts make no Paddle
  call. Completion waits for full provider destruction proof.

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

Application rollback is safe because migration `0017` is additive. Stop new
invites, keep affected tenant routing closed, deploy the prior Substrate release,
and pin cells to its compatible protocol/release. Never roll back by copying or
rewriting live vault content.

Before a cell release rollback, quiesce and verify an export. Start a replacement
cell on the prior compatible image, restore into an empty volume, require full
readiness, then atomically swap the binding. Keep the prior cell sealed but not
destroyed until the replacement passes recall and sentinel-isolation checks.

Paddle rollback only disables checkout by removing `EXOMEM_PADDLE_PRICE_ID` and
redeploying. Existing internal entitlements and complimentary accounts continue
to route without a Paddle request.

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
