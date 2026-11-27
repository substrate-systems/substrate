# Exomem Cloud — Substrate Operator Runbook

Substrate is the account, entitlement, OAuth and billing control plane for
Exomem Cloud. It admits owners, takes payment through Paddle, and records each
tenant's cell row and its `desired_state`. Exomem's cellctl creates and runs
the cells; the Substrate gateway passes MCP traffic to them. This runbook
covers the Substrate side. The Cloud design is the OpenSpec change
`adopt-exomem-cloud-plain-cells`; directory reviewer access has its own
runbook, `exomem-cloud-reviewer-access.md`.

## Substrate configuration

Set secrets in every Vercel environment that can run an Exomem route, then
redeploy. The exceptions are `EXOMEM_CLOUD_GRANT_SIGNING_KEY` and
`EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY`: set them in Production only, because
a Preview build runs unreviewed branch code that could read the keys and mint
grants. Never reuse a cell credential as a control-plane secret.

| Variable                                                                                                                                                                                                                                                                                                                   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                                                                                                                                                                                                                             | Postgres connection used by migrations and product-scoped rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `EXOMEM_PUBLIC_BASE_URL`                                                                                                                                                                                                                                                                                                   | Production HTTPS origin of the app pages and the OAuth issuer: `https://substratesystems.io` until sign-in moves to the product host, then `https://evermatter.ai` on the web app only. The gateway keeps `https://substratesystems.io`, so its protected-resource metadata keeps naming the company issuer for every connection. Credentials, query, fragment and non-root paths are rejected, and there is no request-derived fallback. Development HTTP is loopback-only.                                                                                                            |
| `EXOMEM_ADMIN_TOKEN`                                                                                                                                                                                                                                                                                                       | At least 32 random bytes, known only to operators. Protects the operator API and page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `EXOMEM_CONTROL_PLANE_KEY`                                                                                                                                                                                                                                                                                                 | Exactly 32 random bytes as unpadded base64url, on the web app and the gateway. Seals OAuth continuations and queued email payloads, and keys rate-limit buckets. A production web deploy fails without it.                                                                                                                                                                                                                                                                                                                                                                              |
| `EXOMEM_CLOUD_MCP_URL`, `EXOMEM_CLOUD_MCP_PATH`                                                                                                                                                                                                                                                                            | The Cloud MCP resource URL and its path on the gateway. The web app and the gateway must name the same resource. A missing value fails OAuth closed. Change the URL only in the deploy that removes its host from `EXOMEM_CLOUD_MCP_URLS`.                                                                                                                                                                                                                                                                                                                                              |
| `EXOMEM_CLOUD_MCP_URLS`                                                                                                                                                                                                                                                                                                    | Optional: the accepted resource URLs, newest first, comma-separated, each written as `https://host/path` on the gateway path and including `EXOMEM_CLOUD_MCP_URL`. The web app and the gateway carry the same list; deploy the web app first. A bad list fails the web build and the gateway readiness check. Unset, `EXOMEM_CLOUD_MCP_URL` is the only resource.                                                                                                                                                                                                                       |
| `EVERMATTER_SITE_ORIGIN`                                                                                                                                                                                                                                                                                                   | Optional: the product site's bare HTTPS origin. Set, the public product pages serve at its root, their `/exomem` paths on the company site redirect there, and app pages redirect to `EXOMEM_PUBLIC_BASE_URL`'s host. Once `EXOMEM_PUBLIC_BASE_URL` names this origin, the app pages serve at its root too, and every app link that the web app sends uses the root address. On the gateway it changes no link while the gateway's `EXOMEM_PUBLIC_BASE_URL` stays on the company site. Set it only once the origin serves TLS.                                                          |
| `EXOMEM_CLOUD_CELL_TOKEN_KEY`                                                                                                                                                                                                                                                                                              | Gateway only: 32 bytes as hex, used to derive each cell's bearer. The web app does not need it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `CRON_SECRET`                                                                                                                                                                                                                                                                                                              | Vercel-only bearer for unrelated daily and weekly jobs. Never install it in the K3s scheduler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EXOMEM_HOSTED_SCHEDULER_SECRET`                                                                                                                                                                                                                                                                                           | Dedicated active bearer shared only by the two Exomem scheduled routes and the K3s scheduler.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS`                                                                                                                                                                                                                                                                                  | Optional Vercel receiver-only overlap during rotation. Absent in steady state and never installed in K3s.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `EXOMEM_HOSTED_ALERT_TOKEN_SHA256`                                                                                                                                                                                                                                                                                         | SHA-256 of the scheduler alert receiver capability for `/api/exomem/alerts/[token]`. Unset means the endpoint answers `404`. Only the digest belongs here.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `EXOMEM_HOSTED_ALERT_TOKEN_SHA256_PREVIOUS`                                                                                                                                                                                                                                                                                | Optional receiver-only overlap during alert capability rotation. A malformed value is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EXOMEM_KEY_WATCHER_ALERT_TOKEN_SHA256`                                                                                                                                                                                                                                                                                    | SHA-256 of the object-store key watcher's own capability. It may report only job `b2-key-watcher`, and the scheduler capability may never report that job. Setting it enables the daily `KEY_WATCHER_STALE` check (`/api/cron/exomem-key-watcher`), which runs daily and fires when the last hourly run is more than two hours old, so a stopped watcher is caught within about a day.                                                                                                                                                                                                  |
| `EXOMEM_KEY_WATCHER_ALERT_TOKEN_SHA256_PREVIOUS`                                                                                                                                                                                                                                                                           | Optional overlap during key-watcher capability rotation. A malformed value is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ANTHROPIC_API_KEY`                                                                                                                                                                                                                                                                                                        | The key for the monthly What's new ranking (`/api/cron/whats-new-digest`), one model call a month. Unset leaves the month waiting in "model not configured" on the approval page (`/exomem/operator/whats-new`), and no call is made. `ANTHROPIC_BASE_URL` overrides the API address and is unset in production.                                                                                                                                                                                                                                                                        |
| `EXOMEM_WHATS_NEW_MODEL`                                                                                                                                                                                                                                                                                                   | Optional. The model for that ranking; the default is `claude-haiku-5-5`. A change of this name, of the model the API reports, or of the prompt restarts the measurement that can lift the operator's approval.                                                                                                                                                                                                                                                                                                                                                                          |
| `EXOMEM_WHATS_NEW_GITHUB_TOKEN`, `EXOMEM_WHATS_NEW_GITHUB_API_URL`                                                                                                                                                                                                                                                         | Required to build a month. A read-only token for Evermatter's public releases and the API address (default `https://api.github.com`). Unset makes no GitHub call: the month waits in "GitHub token not configured", the daily route answers 503, and the approval page says so.                                                                                                                                                                                                                                                                                                         |
| `EXOMEM_WHATS_NEW_FIRST_MONTH`                                                                                                                                                                                                                                                                                             | Required to build a month. The first month the daily route builds, as `YYYY-MM`: the month before the one in which Evermatter's notes-file change ships, because that change attaches the file to every release published since the start of the previous UTC month. Until it ships a month waits and names the releases without a file. Unset builds nothing, and the approval page (`/exomem/operator/whats-new`) says so.                                                                                                                                                            |
| `EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY`                                                                                                                                                                                                                                                                                         | Required to send a month. The key that signs the digest's unsubscribe links: exactly 32 random bytes as unpadded base64url, on the web app only, and never the control-plane key. Unset queues nothing, and the approval page says so. Rotate it with `EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY_PREVIOUS` (see "Monthly What's new email"). A key that is set but malformed queues nothing, and so does a malformed `..._PREVIOUS`. Generate it as the control-plane key is generated (see "External scheduler").                                                                               |
| `EXOMEM_CLOUD_DEPLOY_ALERT_TOKEN_SHA256`                                                                                                                                                                                                                                                                                   | SHA-256 of the release automation's own alert capability. It may report only job `cloud-deploy`, and no other capability may report that job. It runs on each release and once a day. No missed-run check watches it.                                                                                                                                                                                                                                                                                                                                                                   |
| `EXOMEM_CLOUD_DEPLOY_ALERT_TOKEN_SHA256_PREVIOUS`                                                                                                                                                                                                                                                                          | Optional overlap during cloud-deploy capability rotation. A malformed value is ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EXOMEM_DEPLOY_TOKEN`                                                                                                                                                                                                                                                                                                      | Production only. The release automation's token, separate from `EXOMEM_ADMIN_TOKEN`. It reads the rollout view and sets `cellImage` with its `release`, and nothing else. Seed the image history before you set it. See "Cloud releases" below.                                                                                                                                                                                                                                                                                                                                         |
| `EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY`                                                                                                                                                                                                                                                                                       | The repository that new cell images publish to, `ghcr.io/substrate-systems/evermatter`. Substrate accepts a fleet or cell image only as `<repository>@sha256:<digest>`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY_PREVIOUS`                                                                                                                                                                                                                                                                              | Optional. The repository of releases published before the image moved, `ghcr.io/artexis10/exomem`, so a rollback to one of them is accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EXOMEM_HOSTED_ALERT_RECIPIENT`                                                                                                                                                                                                                                                                                            | Alert address. Production sets `alerts@substratesystems.io`; unset falls back to `founder@substratesystems.io`, so a missing value never drops an alert. The receiver emails an alert when its state changes, and again when its job reports it as active more than 23 hours after the last email. The K3s scheduler reports only changes, so its alerts email once.                                                                                                                                                                                                                    |
| `BREVO_API_KEY`                                                                                                                                                                                                                                                                                                            | Delivers invite, magic-link, deletion-confirmation, cancellation and alert email.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`                                                                                                                                                                                                                                                                                  | `BREVO_SENDER_EMAIL` is required: the verified default sender for mail that names none (Endstate claim and webhook mail). Exomem mail passes its own sender. `BREVO_SENDER_NAME` is optional.                                                                                                                                                                                                                                                                                                                                                                                           |
| `BREVO_API_BASE_URL`                                                                                                                                                                                                                                                                                                       | Unset in production, which sends to `https://api.brevo.com/v3`. Tests point it at a stand-in. The API key goes to this host.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `BREVO_WEBHOOK_TOKEN`                                                                                                                                                                                                                                                                                                      | Web app only. The bearer token that `POST /api/webhooks/brevo` requires from Brevo. Unset, the route answers `503` and stores nothing. See "Email delivery" below.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EXOMEM_HEALTH_START_CANARY_EMAIL`                                                                                                                                                                                                                                                                                         | Web app only. The address the email health proof starts a sign-in with every 30 minutes. It must have no Exomem account, be on our own domain, and be accepted and dropped by the mail host. Unset or not an email address, the email proof fails. See "Functional health" below.                                                                                                                                                                                                                                                                                                       |
| `EXOMEM_HEALTH_CANARY_QUEUE_SECONDS`                                                                                                                                                                                                                                                                                       | Web app only. How long after its due time Brevo must have accepted the previous canary email. Default 60. A positive whole number of seconds.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `EXOMEM_HEALTH_CANARY_DELIVERY_SECONDS`                                                                                                                                                                                                                                                                                    | Web app only. How long after accepting the previous canary email Brevo must have reported it `delivered`. Default 600. A positive whole number of seconds.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PADDLE_ENVIRONMENT`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`                                                                                                                                                                                                                                                            | One matching Paddle environment, merchant API key and webhook-verification secret. Keep them configured after new checkout stops, so existing paid accounts can reconcile, manage billing and delete safely.                                                                                                                                                                                                                                                                                                                                                                            |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `NEXT_PUBLIC_PADDLE_ENVIRONMENT`                                                                                                                                                                                                                                                        | Browser checkout token and the same environment as the merchant configuration. A mismatch fails closed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EXOMEM_PADDLE_CATALOG_ENVIRONMENT`, `EXOMEM_PADDLE_PRODUCT_ID`                                                                                                                                                                                                                                                            | The environment and the Exomem product that the server selects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `EXOMEM_PADDLE_PRICE_ID`                                                                                                                                                                                                                                                                                                   | The price that checkout charges and Home shows. This is the new-checkout gate: remove it to stop new checkout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EXOMEM_PADDLE_DUNNING_DAYS`                                                                                                                                                                                                                                                                                               | Days that Paddle retries a failed payment, as set in payment recovery. Home shows "read-only until" as the failed-payment start plus these days. Unset or outside 1 to 365, that date is unknown.                                                                                                                                                                                                                                                                                                                                                                                       |
| `EXOMEM_PADDLE_FRIEND_PRICE_ID`                                                                                                                                                                                                                                                                                            | The dedicated monthly friend price for this Paddle environment. Checkout uses this price without a discount; Paddle supplies localized amounts and tax.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EXOMEM_PADDLE_FRIEND_DISCOUNT_ID`                                                                                                                                                                                                                                                                                         | The legacy recurring friend discount. Existing subscriptions remain recognized; checkout uses it only while the dedicated friend price is unset.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `EXOMEM_TURNSTILE_SECRET_KEY`                                                                                                                                                                                                                                                                                              | Cloudflare Turnstile secret for "Start with your email". Unset, a secret that Cloudflare rejects, or a Cloudflare test secret in production leaves only the rate limits, and the web app logs `bot check unavailable` at error level.                                                                                                                                                                                                                                                                                                                                                   |
| `NEXT_PUBLIC_EXOMEM_TURNSTILE_SITE_KEY`                                                                                                                                                                                                                                                                                    | The matching Turnstile site key for the start form's widget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EXOMEM_SELF_SERVE_ADMISSION`                                                                                                                                                                                                                                                                                              | `waitlist` (default) or `open`. See "Start admission" below. An unset or unrecognized value reads as `waitlist`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `EXOMEM_SELF_SERVE_ADMISSIONS_PER_HOUR`                                                                                                                                                                                                                                                                                    | Start links that `open` mode hands out per hour, to newcomers and promoted people together. Unset or not a positive whole number reads as 5. See "Start admission" below.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `EXOMEM_CLOUD_EXPORTS_ENABLED`                                                                                                                                                                                                                                                                                             | `true` turns on the owner export once the cell controller packs exports; anything else is off. The landing and privacy pages read it at build time, so a change needs a redeploy.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `EXOMEM_CLOUD_GRANT_SIGNING_KEY`                                                                                                                                                                                                                                                                                           | Production only; never set it in Preview or Development. Web app only: an Ed25519 private key in PEM form that signs the operation grant of each export and import request. Use a key apart from `EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY`, and give each cell only the matching public key. Unset, Substrate signs no grant, the request row keeps a NULL grant, and the cells log `grant_missing`. A value that is not an Ed25519 private key is logged by name only and treated as unset.                                                                                                  |
| `EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY`                                                                                                                                                                                                                                                                                  | Production only; never set it in Preview or Development. Web app only: an Ed25519 private key in PEM form that signs the deletion grant Substrate stores when it deletes a cell. Use a key apart from `EXOMEM_CLOUD_GRANT_SIGNING_KEY`, and give the Exomem executors only the matching public key, through their `cellDeletion.grantPublicKeys` value. Unset, a cell deletion still succeeds and stores no grant, and nothing purges the cell's backups or media. A value that is not an Ed25519 private key is logged by name only and treated as unset.                              |
| `EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY`                                                                                                                                                                                                                                                                                        | Gateway only: an Ed25519 private key in PEM form. When it is set, the gateway signs an origin proof on every `/mcp` request to every cell, and each cell needs the matching public key to check it. Artifact transport and uploads still need their own switches. A value that is set and is not an Ed25519 private key is logged by name only (`exomem_cloud_artifact_signing_key_invalid`, on the 1st, 2nd, 4th, 8th... load) and read as unset, so the cells report the requests as unproven. With artifact transport or uploads on, the same value fails the gateway configuration. |
| `EXOMEM_CLOUD_TRANSFER_TOOLS_ENABLED`                                                                                                                                                                                                                                                                                      | Gateway only. `true` serves `observe_transfer` and `transfer_memory` from the control plane. Needs gateway HTTPS egress (chart flag `cloudGateway.transferTools.enabled`). Anything else is off, the rollback.                                                                                                                                                                                                                                                                                                                                                                          |
| `EXOMEM_CLOUD_HOLD_BUDGET_SECONDS`, `EXOMEM_CLOUD_HOLD_INTERVAL_MS`, `EXOMEM_CLOUD_HOLD_JITTER_MS`, `EXOMEM_CLOUD_HOLD_RETRY_AFTER_SECONDS`, `EXOMEM_CLOUD_HOLD_MAX`, `EXOMEM_CLOUD_HOLD_MAX_PER_TENANT`, `EXOMEM_CLOUD_CONNECT_TIMEOUT_MS`, `EXOMEM_CLOUD_UPSTREAM_TIMEOUT_SECONDS`, `EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS` | Gateway only, all required: the gateway does not start without each one. The platform chart renders them from `cloudGateway.hold.*` and `cloudGateway.upstream.*`. See "The gateway hold" below.                                                                                                                                                                                                                                                                                                                                                                                        |
| `EXOMEM_CLOUD_UPLOAD_ENABLED`, `EXOMEM_CLOUD_UPLOAD_CELL_IDS`                                                                                                                                                                                                                                                              | Gateway only. `true` plus a JSON array of cell IDs serves Cloud upload handoffs for exactly those cells, signed with `EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY`. Each selected cell needs the matching public key; see Exomem's `cloud-upload-handoff` runbook. The ingress must route `POST /upload` to the gateway. Anything else is off, the rollback. Artifact transport alone never enables uploads.                                                                                                                                                                                      |
| `EXOMEM_STATUS_PAGE_URL`                                                                                                                                                                                                                                                                                                   | Optional, on the web app and the gateway. The https address of the public status page. The web app's "Status page" links, service-notice emails and the assistant's sentence point to it, and use `https://status.substratesystems.io` when it is unset. A value that is not https or is over 200 characters is ignored, with one `exomem_status_page_url_rejected` warning per process. See "Service notices" below.                                                                                                                                                                   |
| `OPENAI_APPS_CHALLENGE`                                                                                                                                                                                                                                                                                                    | Provider-issued single-line domain proof. Set it only in deployment configuration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED`                                                                                                                                                                                                                                                                               | Leave unset or `false`. See `exomem-cloud-reviewer-access.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `EXOMEM_CONNECTOR_SETTINGS_URLS`                                                                                                                                                                                                                                                                                           | Optional JSON object from client platform to the https page where its users manage connectors. The consent view offers it for "Connect after all". An unset or invalid entry offers no link.                                                                                                                                                                                                                                                                                                                                                                                            |
| `EXOMEM_OAUTH_LAPSED_CONNECTOR_GRACE_HOURS`                                                                                                                                                                                                                                                                                | Optional. Hours after its metadata expired before the sweep retires a connector that held a grant. Default 336 (14 days). A value that is not a whole number of at least 1 fails the sweep.                                                                                                                                                                                                                                                                                                                                                                                             |
| `EXOMEM_OAUTH_IDLE_CLIENT_GRACE_HOURS`                                                                                                                                                                                                                                                                                     | Optional. Hours before the sweep retires a generic client holding nothing, or a connector with no grant since it registered. Default 24. A value that is not a whole number of at least 1 fails the sweep.                                                                                                                                                                                                                                                                                                                                                                              |
| `EXOMEM_OAUTH_REFRESH_IDLE_DAYS`                                                                                                                                                                                                                                                                                           | Optional. Days a connected app's refresh token stays valid unused. Every refresh renews it. Default 30, maximum 90. See "Connected-app sessions" below.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EXOMEM_OAUTH_SESSION_MAX_DAYS`                                                                                                                                                                                                                                                                                            | Optional. Days from sign-in at which a connected app must authorize again, however active it is. Default 365, maximum 730. Applies to new sign-ins only.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `EXOMEM_OAUTH_REFRESH_REUSE_SECONDS`                                                                                                                                                                                                                                                                                       | Optional. Seconds after a refresh token is spent in which its own client may present it again and get a fresh pair. Default 604800 (7 days), maximum 2592000 (30 days). Unset reads as 604800; 0, or a value that is not a whole number, turns it off.                                                                                                                                                                                                                                                                                                                                  |

Rate-limit bucket identifiers are domain-separated HMACs under the control-plane
key, never plain hashes of email or IP addresses. The access-delivery job prunes
buckets older than the longest window plus one hour, in bounded batches.

## OAuth and client admission

The authorization server metadata is at
`/.well-known/oauth-authorization-server/api/exomem/oauth`. The endpoints are
`/api/exomem/oauth/authorize`, `/token` and `/revoke`. Each token is bound to one
resource by exact equality, and the Cloud accepts a token for any resource in
`EXOMEM_CLOUD_MCP_URLS` (`EXOMEM_CLOUD_MCP_URL` alone while that is unset). A grant always carries both
`exomem.read` and `exomem.write`. Token issuance requires a non-deleted cell
row for the tenant.

MCP bearer credentials belong only in the `Authorization` header. Never put
them in a URL, cookie, tool argument, log or cell header.

`EXOMEM_CONTROL_PLANE_KEY` has one envelope key and no key ID, so do not rotate
it in place. If it changes by accident, restore the exact old key before serving
traffic. Never rotate by deleting token, grant or family rows. Revoke a
compromised client family first. Use account-wide revocation only when every
client must re-authorize.

### Connected-app sessions

A connected app stays signed in through refresh tokens. Each refresh replaces
the token and renews its idle window, so an app that refreshes at least once
per `EXOMEM_OAUTH_REFRESH_IDLE_DAYS` (30 by default) never asks its person to
sign in again, until `EXOMEM_OAUTH_SESSION_MAX_DAYS` (365 by default) after the
sign-in. Then the person authorizes the app once more. A change to either
setting applies to the next token that Substrate issues. A family that exists
already keeps the ceiling it was issued with.

Each variable takes a whole number. An unset variable reads as its default. A
value that is not a whole number of at least the minimum (for example `off`,
`-1` or `Infinity`) reads as the default for the two day settings, and as 0 for
the reuse interval, which turns reuse off. A value above the maximum reads as
the maximum. Each such read logs a warning with the event
`exomem_oauth_session_config_invalid`, the variable name and the value used.
Check for it after a deploy that changes these variables.

Parallel sessions of one app often share one stored refresh token, and a reply
to a refresh can be lost. Both make a client present a token that Substrate has
already spent — sometimes hours or days later, when one process kept a copy
another process rotated. For `EXOMEM_OAUTH_REFRESH_REUSE_SECONDS` (seven days
by default) after the spend, such a presentation gets a fresh pair in the same
family, and Substrate logs `exomem_oauth_refresh_reused` with the client ID,
the family ID and `spend_age_seconds`, the token's age since its spend. The
family stays live. This applies only while the family and its grant are
unrevoked and the family is unexpired, and the same admission checks as a first
rotation apply.

After that interval the presentation is stale: the token is refused with
`invalid_grant` and the family is NOT revoked — sessions holding the family's
other tokens keep working. Substrate logs `exomem_oauth_refresh_reuse_stale`
with the client ID, family ID and spend age, metadata only. A spent token that
another client presents gets no tokens, and creates no token or grant row.

Know what the reuse interval gives away. The client ID is public and does not
authenticate the party that presents a token, so anyone who holds a refresh
token within the interval of its legitimate spend can use it:

- Each reuse starts an independent chain. That chain rotates and renews like any
  other, up to the session ceiling (365 days by default), and each minted
  refresh token still expires inside its own idle window.
- Nothing but revoking the family, or the grant through Disconnect, ends such a
  chain — a stale presentation refuses only itself.
- One spent token mints at most 64 children: the one its spend created, plus
  at most sixty-three reuses. This is a loop guard for a client stuck
  re-presenting one token, not a bound on a thief — every minted token fans
  out on its own spend, so only revoking the family or grant ends what a
  stolen token starts.

Set `EXOMEM_OAUTH_REFRESH_REUSE_SECONDS` to 0 to refuse every spent-token
presentation at once.

One or two `exomem_oauth_refresh_reused` events for a family match a lost reply
or a parallel session; a large `spend_age_seconds` matches a session that came
back after days away. A pinned client's ID is shared by every user of its
platform, so read the family ID. When one family keeps reusing and its owner
cannot explain it, revoke that family as described below. The owner ends a
sign-in themselves in Home: "Connected apps", then "Disconnect" beside the app,
which revokes the grant and every family under it.

#### Whether an app can still reach the Exomem

An app can reach its owner's cell only while at least one token family under
its grant is unrevoked and still holds a usable credential: an unconsumed,
unexpired refresh token, or — for a family issued without refresh — an
unrevoked, unexpired access token. The refresh token's `expires_at` is the
real idle window; the family row's own `expires_at` is only the session
ceiling the tokens are already capped by. A family whose last refresh token
expired a day ago is dead even though its row reads unexpired for months.
This one rule (`exomem_oauth_family_live_until`, migration 0089) decides
everywhere a sign-in state is read.

Home's "Connected apps" rows now say so: "signed in" while a family is live,
"signed out since `<date>`" (the day the last live family ended, by
revocation or by its last credential expiring) with the remedy "open `<app>`
and connect Exomem again", and "sign-in unknown" when the state cannot be
read — an unreadable state is never shown as signed in. A grant stays in the
list while it is unrevoked, so a signed-out app still offers Disconnect.

#### The sign-out email

When the last live family under a grant ends without the owner's action — a
replay revocation, the idle window or the session ceiling expiring, or an
operator family revocation — the OAuth lane of `exomem-reconcile` emails the
owner once per family: which app (the display name Home shows; a name the app
declares itself is marked as its own claim), when access ended, that nothing
the app saves reaches the Exomem until it reconnects, and to open the app and
connect Exomem again. The email goes through the normal outbox with delivery
evidence (see "Email delivery" below), and cancels at send time if the owner
disconnected or reconnected meanwhile or the account is gone.

The rules:

- The grant must have been used within the last 14 days
  (`exomem_oauth_grant_usage.last_used_at`); a quieter app gets no email.
- Owner disconnects (`owner_disconnected`), the client's own revocation
  (`client_revoked`) and account, cell or reviewer lifecycle endings
  (`lifecycle_deleted`, `cloud_cell_deleted`,
  `reviewer_credential_revoked`) send nothing.
- At most one email per grant per 24 hours. A durable marker row per family
  (`exomem_oauth_app_signout_notices`, migration 0089) makes the notice
  once-per-family under retries and concurrent sweeps; the sweep detects
  endings within a 25-hour lookback in batches of 100, and deletes markers
  older than 30 days, bounded per run.
- Marketplace reviewer tenants never get the email, and Home's own channel
  (a first-party client) cannot be the app it names.
- Each queued email logs the content-free event `oauth.app_signout.notified`
  with the tenant ID and `emailKind` `app_signout` — metadata only, no app
  names. The reconcile result's `oauth.signouts` carries `candidates` and
  `emailed`, or `null` when that lane failed (logged as
  `exomem-oauth: app sign-out notice lane failed`).

Rollback note: a rollback to a release without the `app_signout` email kind
drains queued notices as failed — the outbox claims each row, finds the kind
unregistered (`EMAIL_KIND_UNREGISTERED`) and settles it as failed. They are
not re-sent when the fixed release returns.

### Measure refresh-token reuse ages

The reuse window (`EXOMEM_OAUTH_REFRESH_REUSE_SECONDS`) is meant to shrink to
the longest reuse that clients actually need; its default is 7 days. The token table
already records each reuse: a refresh token's second and later children were
minted from the already-spent parent. This query reports, per app, how old the
spent token was at each reuse and how many rotations its session had missed. It
reads only sign-in metadata.

1. Set `since` to the first full day after the grace change deployed.
2. Run the query below with `psql "$DATABASE_URL" -v since=<YYYY-MM-DD> -f <file>`.
3. Propose a tighter window above the largest `p99_age` across apps, with margin.

The parent scan is unindexed on `consumed_at`; at current volume it finishes
well inside its 60-second timeout. Expected result: one row per app that reused
a token, with ages and missed-rotation counts.

```sql
-- Refresh-token reuse ages since the grace change. Read-only, metadata only.
-- A reuse is a refresh token's second or later child: the first child is the
-- ordinary rotation; each later one was minted from the already-spent parent.
-- Both measures read the children's created_at, the transaction-start clock:
-- the parent's consumed_at is clock_timestamp() after the rotation's locks,
-- so the first child always predates it and a window anchored on consumed_at
-- would drop that rotation from every count.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '60s';
WITH reuse AS (
  SELECT family.client_id,
         reuse_child.created_at - first_child.created_at AS age,
         (SELECT count(*) FROM exomem_oauth_refresh_tokens AS meanwhile
           WHERE meanwhile.family_id = parent.family_id
             AND meanwhile.created_at >= first_child.created_at
             AND meanwhile.created_at < reuse_child.created_at) AS rotations_missed
  FROM exomem_oauth_refresh_tokens AS parent
  JOIN exomem_oauth_token_families AS family ON family.id = parent.family_id
  CROSS JOIN LATERAL (
    SELECT created_at FROM exomem_oauth_refresh_tokens AS child
    WHERE child.parent_refresh_token_id = parent.id
    ORDER BY created_at LIMIT 1
  ) AS first_child
  JOIN LATERAL (
    SELECT created_at FROM exomem_oauth_refresh_tokens AS reuse_child
    WHERE reuse_child.parent_refresh_token_id = parent.id
    ORDER BY created_at OFFSET 1
  ) AS reuse_child ON true
  WHERE parent.consumed_at >= :'since'::timestamptz
)
SELECT coalesce(client.client_name, client.client_platform, client.admission_mode) AS app,
       count(*) AS reuses,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY age) AS p50_age,
       percentile_disc(0.9) WITHIN GROUP (ORDER BY age) AS p90_age,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY age) AS p99_age,
       max(age) AS max_age,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY rotations_missed) AS p50_rotations_missed,
       max(rotations_missed) AS max_rotations_missed
FROM reuse
JOIN exomem_oauth_clients AS client ON client.id = reuse.client_id
GROUP BY 1
ORDER BY reuses DESC;
ROLLBACK;
```

### Revoke connected apps

Revoke the narrowest scope that stops the problem. Each step takes effect on the
next token request or MCP call. An access token fails at once, because every call
checks the family and grant, and a refresh token fails at its next use.

1. To disconnect one app, ask its owner to open Home, go to "Connected apps",
   and press "Disconnect" beside the app, then confirm. This revokes the app's
   grant and every token family under it, with the reason `owner_disconnected`.
   Other apps stay connected.
2. To revoke one family as an operator, find its ID and send the request below.
   The family ends; the grant stays, so the app can authorize again.
   ```bash
   curl -sS -X POST "$EXOMEM_PUBLIC_BASE_URL/api/exomem/admin/oauth-revocations" \
     -H "Authorization: Bearer $EXOMEM_ADMIN_TOKEN" -H "Content-Type: application/json" \
     -d '{"action":"family","ownerUserId":"<user-uuid>","tenantId":"<tenant-uuid>","familyId":"<family-uuid>"}'
   ```
   The response is `{"success":true,"revoked":true,...}`. To find the family,
   list the account's live families with the read-only query below.
   ```sql
   SELECT family.id, client.client_id, family.created_at, family.expires_at
   FROM exomem_oauth_token_families AS family
   JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = family.grant_id
   JOIN exomem_oauth_clients AS client ON client.id = family.client_id
   WHERE oauth_grant.user_id = '<user-uuid>' AND oauth_grant.tenant_id = '<tenant-uuid>'
     AND family.revoked_at IS NULL AND family.expires_at > now();
   ```
3. To revoke every family on an account, send the same request with
   `"action":"account"` and no `familyId`. This revokes every grant, family and
   unused authorization code of the account, and it also blocks the account from
   authorizing again. No route lifts that block, so use it only when every app
   of that account must lose access for good. The response gives
   `revokedFamilies`.
4. An app can revoke its own token through `/api/exomem/oauth/revoke` (RFC 7009),
   with the form fields `token` and `client_id`. Substrate answers `200` for a
   well-formed request, whether or not the token existed.

A revoked app never regains access with an old token. The person connects the
app again from the app's own connect step, which creates a new grant and family.

### Withdraw or revive a self-registering client

A client is admitted when it is enabled and either pinned, admitted through the
generic lane, or serving a valid metadata document from a host in
`exomem_oauth_admitted_cimd_hosts` (`chatgpt.com` → `openai`, `claude.ai` →
`claude`). Clients on an admitted host register and refresh themselves on
contact with `/authorize`. While the generic lane is enabled a CIMD client from
any other https host registers the same way, with no platform and a slot in the
generic partition; see "Generic MCP clients" below.

To withdraw one, delete its allowlist row. Setting `enabled = false` on the
client is not a durable off switch, because the next anonymous contact
re-enables it. Deleting the row for `claude.ai` withdraws every Claude client,
because claude.ai serves one global client document.

While the generic lane is enabled a deleted host no longer withdraws its
clients by itself: the lane admits them like any other unlisted host. There is
no one-action way to withdraw a single unlisted host while the lane stays
open -- deleting the allowlist row only removes the platform binding, and
disabling the client's row is undone by its next `/authorize` contact, which
re-registers and re-enables it. The one broad withdrawal is closing the lane
(`exomem_oauth_generic_client_lane`), which cuts every generic and unlisted
CIMD client at once. A per-host block list is a tracked follow-up in
`admit-standard-mcp-clients`; until it ships, weigh that cost before enabling
the lane.

Cached metadata lives 24 hours. When it lapses, the sweep disables the row, and
token issuance, refresh and MCP calls need unexpired metadata. A self-registered
connector's next refresh fetches the document again, through the same allowlist
and checks as `/authorize`, revives the row and then rotates the token. Its MCP
calls fail with `401` only until that refresh. If the fetch or a check fails,
`/token` answers `503` with `server_error` and leaves the refresh token unspent,
so the client keeps its tokens and tries again later. A refresh token that is
not live still gets `invalid_grant`. A lapse is not a revocation and burns no
refresh token. An operator-registered client is not fetched again at refresh.

The rate-limit rule `oauthConnectorMetadataRefetchFailureClient` counts the
failed re-fetches of each client ID. A successful re-fetch counts nothing. Past
the limit, a refresh that needs the document gets the same `503` without a
fetch until the window ends. Each such refresh logs
`exomem_oauth_connector_metadata_refetch` with an `outcome` of `refreshed`,
`failed` or `rate_limited`. Each `503` also logs the token rejection stage
`refresh_metadata_unavailable` with the client ID.

Withdrawing a host leaves one known residual. `/token` cannot tell a withdrawn
host from a failed fetch. Once a withdrawn host's connector has lapsed metadata,
its live refresh tokens get `503` with `server_error`, not `invalid_grant`. Its
client keeps those tokens and retries until they expire or you revoke their
family. Its MCP calls answer `401` throughout.

Operator registration and enabling of a pinned client still check the legacy
Hosted staged-release and artifact rows. A follow-up change must replace that
authority before a new pinned client can be registered.

### The first-party Home client

Migration 0066 seeds one client with the admission mode `first_party`. On each
call to an owner's cell, Home's server mints a 120-second token for this
client. The authorization, code exchange and refresh paths of this release
and the one before exclude it: they admit a pinned or generic mode or admitted
CIMD metadata, and no supported writer gives this client metadata. Only the
gateway's token lookup admits the mode. The app list and the client slots
leave the client out.

Deploy the gateway that admits the mode before you set
`EXOMEM_CLOUD_HOME_CHANNEL_ENABLED`. An older gateway refuses every Home token
with `401`, and Home then shows the cell as unreachable. Home's server calls
for every owner from a few shared addresses, so the gateway's per-address
limit skips a first-party token. The per-tenant limit still applies to it.

Migration 0066 stops if an ordinary client already holds the id
`exomem-cloud-home`. Rename or delete that client, then run the migration again.

The operator page can disable the Home client. The gateway then refuses the
tokens that Home minted, and Home shows levels and activity as unavailable
(`HOME_CLIENT_DISABLED`). The page cannot enable the client again, because the
enable path needs a client artifact that this client does not have. To enable
it again:

1. Run this statement against the production database:

   ```sql
   UPDATE exomem_oauth_clients SET enabled = true, updated_at = now()
   WHERE admission_mode = 'first_party';
   ```

2. Open Home for an account with a running cell.

The levels and recent activity show again.

### Generic MCP clients

A generic client is an MCP client that no marketplace distributes, such as
Codex CLI or a hand-written agent. It registers itself through RFC 7591 dynamic
client registration at `/api/exomem/oauth/register`. It has no platform and no
metadata host. The lane ships disabled.

What the lane widens: any program can register and ask for authorization, and
an OAuth client ID metadata document from any https host is admitted on first
contact with `/authorize`, not only the allowlisted hosts. The invite stays the
only way to a tenant. A generic client reaches an account only when the person
who signs in already owns one, or holds an unspent invite. PKCE S256, exact
redirect matching, single-use codes and resource binding apply as for every
other client.

Attribution is lost once the lane is enabled. Admission state cannot tell which
software wrote a memory. A generic client may name itself in `client_name`, and
nothing verifies that name: a generic client can call itself "Claude". The
consent page and Home must show the name as the client's own claim. A client
that declares no readable name has none stored.

Registration has these bounds:

- 5 registrations in 10 minutes per IPv4 address, or per IPv6 /64.
- The generic partition's bound of unretired clients, 50,000 at launch,
  counted apart from operator and allowlisted-CIMD clients. Lane-admitted CIMD
  clients -- auto-registered rows with no platform -- count in the generic
  partition, so a CIMD flood draws on the same bound as DCR. The sweep frees
  the slot of a client that has held nothing for its grace; see "Client slots
  and retirement". When the partition is full, every new registration is
  refused. Read it with `SELECT * FROM exomem_oauth_client_partitions();`.
- Every refusal answers `404` with an empty body, whatever the cause. The log
  event `exomem_oauth_register_rejection` names the stage, never a request value.

Deploy order: the web deploy applies the migration and the grants script; both
predate the image that needs them. Migration 0062 adds the lane and its arm;
0088 adds the one admission function, `exomem_oauth_client_admitted`, and the
stored `client_context`. The gateway reads the function on every token lookup,
for every client, so roll a gateway image that calls it only after that web
deploy, or every MCP call fails. The function exists first, so an older
gateway's inlined rule keeps working against the new schema during the window.

Enable the lane only when all of these are true:

- The deployed release retires idle generic clients
  (`reclaim-oauth-client-slots`, migration 0067), and the reconcile job's
  response includes `oauth.retiredGeneric`. Without slot reclaim, the
  partition fills once and stays full.
- Done in migration 0088 (`admit-standard-mcp-clients`): each OAuth client
  carries a stored `client_context`, coding or conversation, set at
  registration from its redirect shape and readable by the gateway and the
  apps list. The owner changes it on Home. That is right for every client
  admitted at launch, and no longer puts a desktop chat app with a loopback
  callback into coding permanently.
- An independent review has checked that the consent page names the client
  and its scopes plainly, shows the client's name as its own claim, and names
  the verified host that served its document for a CIMD client.
- One real third-party MCP client, such as Codex CLI, has completed
  registration, authorization, tool discovery and a durable capture in a test
  environment with the lane enabled.

To enable the lane:

1. Run this statement against the production database:
   ```sql
   UPDATE exomem_oauth_generic_client_lane SET enabled = true, updated_at = now();
   ```
2. Request `/.well-known/oauth-authorization-server/api/exomem/oauth`.

The document now includes `registration_endpoint`.

To withdraw the lane in one action:

1. Run this statement against the production database:
   ```sql
   UPDATE exomem_oauth_generic_client_lane SET enabled = false, updated_at = now();
   ```
2. Request the metadata document again.
3. If the lane stays off, deploy the web app again. The landing page is static,
   and its connect step tells visitors that any MCP client can connect.

The document has no `registration_endpoint`, and the registration endpoint
answers `404`. Every generic client stops at every stage at once: authorization,
consent, token exchange, refresh and MCP calls through the gateway. A CIMD
client whose host is not allowlisted stops the same way -- its lane was the
generic lane -- while allowlisted CIMD clients and operator clients are not
affected.

Withdrawal suspends live grants; it does not revoke them. Grant and token rows
stay, and enabling the lane again lets unexpired tokens and refresh families work
again. To end them for good, revoke every generic token family:

```sql
UPDATE exomem_oauth_token_families AS family
SET revoked_at = COALESCE(family.revoked_at, now()),
    revoked_reason = COALESCE(family.revoked_reason, 'operator_revoked')
FROM exomem_oauth_clients AS client
WHERE family.client_id = client.id AND client.admission_mode = 'generic';
```

To stop one generic client, set `enabled = false` on its row. Registration never
rewrites an existing row, so that client ID stays stopped. The app can still
register again under a new client ID while the lane is enabled. Once the stopped
client holds nothing for `EXOMEM_OAUTH_IDLE_CLIENT_GRACE_HOURS`, the sweep
retires it, `/token` answers `invalid_client`, and SDK-based apps then register
again by themselves. To keep one person's apps out, revoke that person's access
instead.

### Client slots and retirement

Each client takes one slot in one of three partitions: operator, auto-registered
CIMD connectors, and generic clients. Each partition's bound is a row in
`exomem_oauth_client_partition_bounds`, beside `used`, its count of unretired
clients. Database triggers keep `used` current on every write to the clients
table, so admission reads one row at any population. The function
`exomem_oauth_client_partitions()` returns each partition's `bound` and `used`.
The first-party Home client takes no slot. An
auto-registered CIMD client with no platform is one only the generic lane can
admit, so it counts in `generic`, not `auto_registered`.

| Partition         | Launch bound | What one slot is                                                        |
| ----------------- | ------------ | ----------------------------------------------------------------------- |
| `operator`        | 96           | A client that an operator registered by hand.                           |
| `auto_registered` | 50,000       | A connector on an allowlisted host, or the one global claude.ai client. |
| `generic`         | 50,000       | A dynamically registered app, or a lane-admitted CIMD client.           |

A bound limits two things: the clients connected at the same time, and the rows
that a registration flood can add before the sweep retires them. Each
self-registering bound is 50 clients for each of 1,000 accounts, because a heavy
user runs 15 to 25 apps or more at peak. The load target is 10,000 tenants
(`openspec/project.md`), so raise both self-registering bounds to 500,000 before
the account count passes 1,000. Migration 0093 made the partition check cost the
same at any population: under 1 ms at 500,000 clients per partition.

To change a bound:

1. Run this statement with the partition and the new bound:
   ```sql
   UPDATE exomem_oauth_client_partition_bounds
   SET bound = <new-bound>, updated_at = now()
   WHERE client_partition = '<partition>';
   ```
2. Read the headroom, as described below.

The new bound applies to the next admission. A bound below `used` admits no new
client until enough clients retire. Never delete a row: a partition without a
row refuses every new client, and the headroom read fails.

A retired client keeps its row but takes no slot. Retirement never deletes a
row, so bootstrap provenance stays readable. The database refuses to enable a
retired client and refuses to retire the Home client. The operator enable
action refuses a retired client too. A retired operator client stays retired:
an operator registration of the same client ID leaves it retired and disabled,
so register a new client ID instead. A retired auto-registered connector
revives itself, as described below.

The reconcile job, `/api/cron/exomem-reconcile`, runs the sweep every minute.
Each run does these things:

- It deletes expired authorization transactions, codes and tokens, at most 500
  of each.
- It disables CIMD clients whose metadata expired.
- It retires a disabled auto-registered connector that held a grant once its
  metadata expired more than `EXOMEM_OAUTH_LAPSED_CONNECTOR_GRACE_HOURS` ago.
- It retires a disabled auto-registered connector that never held a grant once
  its last registration is older than `EXOMEM_OAUTH_IDLE_CLIENT_GRACE_HOURS`.
  A flood of connector registrations therefore clears in about a day.
- It disables and retires a generic client that has held nothing for
  `EXOMEM_OAUTH_IDLE_CLIENT_GRACE_HOURS`: the client registered before the
  grace began, and no grant of it was created, renewed or revoked since.
- It retires at most 100 clients per partition.
- Once an hour per partition, it recounts the partition's unretired clients
  exactly and corrects `used`. The response's `partitionRecounts` gives the
  correction for each partition that was due. A non-zero correction logs
  `exomem-oauth: client partition <partition> counter corrected by <n>`, and
  means a write bypassed the counting triggers.

The sweep never retires a client in the view
`exomem_oauth_clients_holding_live_authority`: a client that holds a grant that
is not revoked, an unexpired code, access token or refresh token, or an
authorization in progress. A connected app therefore keeps its slot until its
person disconnects it in Home.

A retired connector revives its own row at its next authorization, if its
partition has a free slot. A full partition refuses it like a new connector.

A retired generic client's ID stops working, and nothing revives it. `/token`
answers `401 invalid_client` for an unknown or retired client ID. Clients built
on the MCP TypeScript SDK (checked against version 1.27) then register again by
themselves. A client that never finished an authorization goes to `/authorize`
instead, which answers `400 invalid_request` without a redirect, as RFC 6749
requires for an unknown client. Its person must remove the app's saved sign-in,
for example by removing and adding the server again, and then connect again.

To read the headroom, request `GET /api/exomem/admin/oauth-clients` with the
operator bearer. The `headroom` object gives `bound`, `used` and `free` for each
partition. The SQL equivalent is `SELECT * FROM exomem_oauth_client_partitions();`.

A recount reads every unretired client, about 70–90 ms with 500,000 in each
self-registering partition, while a registration in that partition waits. A
bounds row that you add has no count until a recount: its partition admits no
new client and the headroom read fails until then. To recount at once, for example after a
restore with triggers disabled or after adding a bounds row by hand, run:

```sql
SELECT client_partition, exomem_oauth_client_partition_recount(client_partition) AS corrected
FROM exomem_oauth_client_partition_bounds;
```

A `NULL` correction means a registration held that partition; run it again.
The sweep reports such a partition as `null` in `partitionRecounts` and
recounts it on its next run.

If the sweep fails, the reconcile job answers `503` and logs
`exomem-oauth: expired state and client retirement lane failed`. A malformed
grace setting fails every run until you correct it.

Migration 0067 changes `exomem_oauth_clients` first, then builds five indexes:
two on grants, two on refresh tokens and one on access tokens. It holds its lock
on clients until it commits, so every read of clients waits for the builds.
Bearer validation reads clients, so every MCP call waits too. Each build also
blocks writes to its own table, such as token issuance and refresh. Before you
deploy the release that contains slot reclaim:

1. Run this read-only query against the production database:
   ```sql
   SELECT relname, reltuples::bigint AS estimated_rows
   FROM pg_class
   WHERE relname IN ('exomem_oauth_grants', 'exomem_oauth_refresh_tokens',
                     'exomem_oauth_access_tokens');
   ```
2. Estimate the wait as about 0.2 to 0.5 seconds per million rows for each
   build.
3. If every table holds fewer than one million rows, deploy as usual.
4. Otherwise, deploy in the quietest hour, and expect MCP calls and token
   requests to wait for the builds.

On a synthetic table of one million rows on local Postgres 16, one build took
0.2 to 0.4 seconds. If a table lock is not free within five seconds, the
migration fails and rolls back, and you can deploy again.

To roll back a release that contains slot reclaim, roll forward if you can. The
earlier code cannot revive a retired connector, because its registration sets
`enabled = true` without clearing `retired_at`, which the database refuses. If
you must roll the code back:

1. Deploy the earlier release.
2. Run this statement against the production database:
   ```sql
   UPDATE exomem_oauth_clients
   SET retired_at = NULL, updated_at = now()
   WHERE auto_registered AND retired_at IS NOT NULL;
   ```

Deploy first: until the earlier release replaces it, this release's sweep can
retire connectors again. Retired connectors then revive on their next
authorization, as before the release. The migration stays applied.

#### Retire spent reviewer bootstrap clients

Nothing creates, consumes or revokes a reviewer bootstrap authority since Hosted
was retired, so the sweep never retires these clients. Each one is disabled and
can never be enabled again, but it still takes an operator slot.

1. Run this read-only query against the production database, and keep its output:
   ```sql
   SELECT client.id, client.created_at,
          ARRAY(
            SELECT DISTINCT authority.state
            FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
            WHERE authority.oauth_client_id = client.id
          ) AS authority_states,
          exomem_oauth_client_holds_live_authority(client.id) AS holds_live_authority
   FROM exomem_oauth_clients AS client
   WHERE client.reviewer_bootstrap_ever_authorized
     AND client.retired_at IS NULL
     AND NOT client.enabled
     AND NOT EXISTS (
       SELECT 1 FROM exomem_marketplace_reviewer_oauth_bootstrap_authorities AS authority
       WHERE authority.oauth_client_id = client.id AND authority.state = 'active'
     )
   ORDER BY client.created_at;
   ```
2. Get the operator's approval for the listed IDs. A row with
   `holds_live_authority = true` stays, and step 3 skips it.

The next step changes live operator capacity. Run it only with the approved IDs.

3. Run this statement with the approved IDs:
   ```sql
   UPDATE exomem_oauth_clients AS client
   SET retired_at = now(), updated_at = now()
   WHERE client.id = ANY('{<approved-id>,<approved-id>}'::uuid[])
     AND client.reviewer_bootstrap_ever_authorized
     AND client.retired_at IS NULL
     AND NOT client.enabled
     AND NOT exomem_oauth_client_holds_live_authority(client.id)
   RETURNING client.id;
   ```
4. Run `SELECT * FROM exomem_oauth_client_partitions();`.

The `operator` row shows `used` lower by the number of rows that step 3
returned. Whether the operator bound of 96 can return to 32 is a separate
decision; take it from this number.

### OpenAI domain proof

OpenAI issues the value for `OPENAI_APPS_CHALLENGE`.

1. Store the exact single-line value in each deployment that serves the canonical origin.
2. Redeploy.
3. Request `/.well-known/openai-apps-challenge`.

The route returns only the plain-text value with `Cache-Control: no-store`. An
absent or unsafe value returns `404`. Never put the value in a shell command,
ticket, screenshot, test fixture or log. To rotate it, replace the value and
redeploy before the provider verifies it. To remove it, delete the variable,
redeploy, and confirm that the route returns `404`.

## External scheduler

Vercel Hobby rejects cron expressions that run more than once per day, so the
frequent Exomem jobs are absent from `vercel.json`. The Exomem platform chart
deploys them from its own schedule file,
`infra/helm/platform/files/exomem-hosted-schedules-v1.json` in the Exomem
repository, as K3s CronJobs. `ops/exomem-hosted-schedules.json` here is the
Substrate-side copy of that contract. Each job calls `https://substratesystems.io`
with `Authorization: Bearer <EXOMEM_HOSTED_SCHEDULER_SECRET>`:

- `/api/cron/exomem-access-delivery`;
- `/api/cron/exomem-reconcile`, which runs Paddle reconciliation, the Cloud
  sweep (checkout expiry, desired-state reconcile, cancellation notices and the
  Cloud deletion finish) and the OAuth sweep (expired credential deletion and
  client retirement; see "Client slots and retirement").

The chart's schedule file sets how often each job runs.

The scheduler receives only the active dedicated secret. It never receives
`CRON_SECRET`, the previous receiver secret, or database, Paddle, cell or
browser credentials. The contract pins GET, redirect rejection, timeouts,
`Forbid` concurrency, deadlines, attempts, job history, content-free metrics
and alert thresholds.

To rotate the dedicated bearer:

1. In Vercel, set the new value as `EXOMEM_HOSTED_SCHEDULER_SECRET` and the old value as `EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS`, then redeploy.
2. Update the SOPS-encrypted K3s scheduler Secret to the new value, and apply the platform release.
3. Prove that every scheduled route succeeds with the new value.
4. Remove `EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS` from Vercel and redeploy.
5. Prove that the old value returns `401` and unrelated cron routes still require `CRON_SECRET`.

Generate a control-plane key without printing raw bytes in shell history:

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

## Paid checkout and reconciliation

Paddle is a billing adapter, never a cell runtime dependency. A paid invite
redemption creates the owner, tenant, an `awaiting_checkout` Paddle entitlement
and one cell row with `desired_state = stopped`. That row holds its Cloud
capacity slot, and cellctl creates nothing for a row that has never run. Home
then creates or resumes a server-selected checkout for `EXOMEM_PADDLE_PRICE_ID`.
The browser cannot select a product, price, tenant, environment or return URL.

A verified active or trialing subscription event makes the entitlement active.
The Cloud reconcile then sets the row to `running`. Duplicate and stale events
change nothing. A tenant still `awaiting_checkout` after 7 days is expired: the
sweep cancels its pending transaction and sets the row to `deleted`, unless
Paddle reports the transaction completed.

A transaction return is accepted only when its exact transaction ID and
provider environment are already bound to the signed-in owner. A settled or
canceled return clears or promotes only the recorded binding. It never creates
a replacement transaction.

Keep the shared Paddle destination at
`$EXOMEM_PUBLIC_BASE_URL/api/webhooks/paddle`, its `PADDLE_WEBHOOK_SECRET`, and
the `transaction.completed` and subscription `created`, `activated`, `updated`,
`past_due`, `paused`, `resumed` and `canceled` events. Rotate the secret on the
destination and the deployment together, or deliveries fail verification.
Provider identifiers stay in Substrate's tables and never reach a cell.

The reconcile job also checks each due Paddle subscription under a 30-second
lease, at most once per six hours after a success. Failures retry from one
minute with exponential backoff capped at six hours. If paid rows exist but the
Paddle configuration is missing or a stored reference belongs to another
environment, the job returns a stable `503` before any Paddle call.

### A lapsed cell that waits for Paddle

When an ended owner's kept window ends, the reconcile job deletes the cell only
after Paddle settles the transaction still bound to it. Until then the cell
stays read-only and holds its Cloud place, and the job counts it in
`cellsWaitingForPaddle`. If that count stays above zero after Paddle is
reachable again:

1. Find the transaction ID in the tenant's `exomem_entitlements.provider_transaction_ref`.
2. Cancel that transaction in the Paddle dashboard, unless it is paid.
3. Wait for the next reconcile run.

The job reads the cancelled transaction, clears the binding and deletes the
cell. A paid transaction resumes the owner instead; do not cancel it.

## Invitations

### Start admission

`POST /api/exomem/access/start` (and its earlier path `/access/magic-link`)
serves new and returning people. Every request with a well-formed address that
passes Turnstile gets the same `202`, and the email carries the outcome. An
address that a browser accepts but the server cannot use, such as
`person@localhost`, gets `400 invalid_email` after Turnstile, and the form asks
the person to check it. That answer depends on the address's shape only, so it
reveals nothing about any account. Every request that passes the rate limits
ends with one outcome email: it queues one, unless a waiting or invited address
repeats a request in the same fixed 15-minute window, when the email queued
earlier in that window stands. An owner gets a sign-in link. An address
with an open operator invitation and no account gets an invitation-waiting
email. It carries a fresh link to that invitation and the date it expires, and
the address does not join the waitlist. The fresh link replaces every earlier
link for the invitation, so a person who lost the invitation email can start.
The invitation keeps its expiry, kind and place in capacity. The system
replaces the link at most once in each fixed 15-minute window, so a repeat
request, or a stranger who submits the address, cannot invalidate the link in
that window's email. While an email that carries the invitation's current link
is being sent, a request replaces nothing and queues nothing. An invitation
email that was queued with an earlier link is cancelled, not sent. If an
invitee reports that their link no longer opens the invitation, tell them to ask
to start again with that address and use the newest email. Anybody else follows `EXOMEM_SELF_SERVE_ADMISSION`:

- `waitlist`: a waitlist place. This is the default, including an unset or
  unrecognized value. The retired `closed` value also reads as `waitlist`.
- `open`: a start link while Cloud has a free place and nobody is waiting,
  else a waitlist place. Each reconcile tick promotes the oldest waiting
  people into free places.

The sign-in canary's waitlist entry (see "Functional health") is never
promoted, and it does not count as somebody waiting, so it never delays a
newcomer's start link in `open` mode.

`open` mode also paces admissions: at most
`EXOMEM_SELF_SERVE_ADMISSIONS_PER_HOUR` start links an hour (default 5), for
newcomers and promotions together, whatever the address. Past it, a newcomer
gets a waitlist place exactly as when Cloud is full, and promotion waits for
the next hour. Each refusal logs `access.start.admission_paced`, content-free.
To admit people faster, raise the pace and redeploy.

A free place is a freshly observed Cloud slot that no live cell and no unused
invitation holds. Every invitation counts, whatever its kind, and one address
counts once. Start links expire after 48 hours. A person who asks again while
they hold a live start link gets another link with the same expiry. Using any
of their links revokes the others. A waiting person who asks again keeps their
place and gets a still-waiting email. It gives no queue position. The system
queues at most one per entry in each fixed 15-minute window.

Three limits can refuse a start request, whatever the address's state: the
network (20 an hour), the browser (1 a minute) and the address (5 an hour).
The `202` then carries `limitedBy` set to `ip`, `browser` or `address`, and
`retryAfterSeconds`. The body always carries `limitedBy`, `null` when no limit
refused the request, so the body keys and the response time stay the same.
`retryLimited` repeats `limitedBy !== null` for a page loaded before `limitedBy`
existed. Each limit says that this request sent no email. No limit says
that the address was emailed. The page gives the wait in words,
such as "in 59 minutes". The limits come before every branch, so they do not
reveal whether an address has an account. Each refused request logs
`access.start.suppressed` with `limit` set to the limit, and never the address.

Emails for start links, waitlist places, promotions, the unpaid-hold
reminder and the account lifecycle (emails 03 to 07) go through
`exomem_email_outbox`. A request that queues an email due now sends it as soon
as its transaction commits: start requests, operator invitations and email
changes. The send runs after the response, under the same lease, re-check and
retry rules as the job. When it fails or never runs, the row stays queued and
the access-delivery job sends it at its next run. The job does not claim a row
while the request's lease holds, so one row is not sent twice. Rows that are
not due yet, such as a reminder, go through the job only.

The access-delivery job sends at most 20 per run, and sends the waitlist,
still-waiting and invitation-waiting emails only when no other email is ready.
It retries a failed send after 1, 2, 4 and up to 60 minutes. An email with a deadline, such as a
start link, retries until that deadline. An email without one, such as 07,
stops after 10 attempts. When Brevo refuses the request (`400`, `413` or
`422`), the row records `EMAIL_REFUSED`. A refused waitlist or still-waiting
email fails at once, and the person keeps their place. Every other refused email retries,
because a refusal can come from our own account, such as an unvalidated
sender. Email 07 also waits, with no limit,
until cellctl has deleted every cell of the account. A wait counts no attempt.
For what became of each email after the provider accepted it, see "Email
delivery" below. To see what is stuck, run:

```sql
SELECT kind, state, last_error_code, count(*)
FROM exomem_email_outbox
WHERE state IN ('pending', 'leased', 'failed')
GROUP BY kind, state, last_error_code;
```

Retention runs on its own. The access-delivery job clears the address of an
outbox row 30 days after the row settles. It also deletes provider delivery
events 30 days after receipt, at most 1,000 per run. The reconcile job deletes a
person's waitlist entry and unused start links 180 days after the later of
their last request and their last start link's expiry, unless the address
owns an Exomem. It keeps used start links and operator invitations. Account
deletion removes every outbox row of the account and every row for the
owner's address, then queues email 07.

#### Release

Start admission ships only in the same deploy as the web journey that calls
it. The start route and its earlier path refuse a request without a Turnstile
token, so the sign-in form of an older web app stops working.

1. Confirm that the deploy contains the journey's start form, which sends a
   Turnstile token made with the action `start`.
2. Confirm that the deploy contains the `/exomem/setup` page, where a paid
   redemption continues.
3. Set `EXOMEM_TURNSTILE_SECRET_KEY` and
   `NEXT_PUBLIC_EXOMEM_TURNSTILE_SITE_KEY` from one Turnstile widget whose
   hostnames include every app host: `substratesystems.io`, and
   `evermatter.ai` before sign-in moves there. The `turnstile-secret` and
   `turnstile-site-key` bindings in `contracts/bws-exomem-production-v1.json`
   select that widget's values.
4. Deploy with `EXOMEM_SELF_SERVE_ADMISSION=waitlist`; new addresses receive a waitlist place.
5. Request a sign-in link for an owner account from the start form. The
   owner receives one sign-in email.
6. Verify that an invited subscriber reaches production Home with working memory and the correct offer; keep admission on `waitlist`.
7. Before opening, publish the subscription Terms and announce the admission change; users can read the purchase conditions.
8. Set `EXOMEM_SELF_SERVE_ADMISSION=open` and redeploy; Cloud admits people when capacity and queue order permit.

To pause admission, set `EXOMEM_SELF_SERVE_ADMISSION=waitlist` and redeploy.
Existing owners can still request sign-in links. Waiting people keep their places.

### Historical invitation cutover

The retired self-serve route returns `410`. The one-time revocation of its
historical invitations applied only before the first admission deployment.
It is not a release prerequisite now: those rows also contain live start links.
Do not repeat the historical bulk revocation after admission has shipped.

### Issue an invite

1. Open `/exomem/operator` directly; it is absent from public navigation and the sitemap.
2. Paste `EXOMEM_ADMIN_TOKEN` into the page. The page holds it only until refresh or "Lock".
3. Enter one email and choose the "Access": "Paid", "Friend (paid, friend price)" or "Covered (complimentary)".
4. For a friend or covered invitation, enter the inviter's name. "Covered" also needs its own confirmation.
5. Send the invitation. The page then refreshes its capacity figures.

The page shows "Cloud places free" from the same count that admission uses.
It shows "Unknown" when no fresh Cloud capacity observation exists. Every
invitation, paid or complimentary, needs a free place when it is issued, and
again when it is redeemed. An invitation to an address that already holds a
Cloud cell needs no place. When Cloud capacity is full, issue returns
`CAPACITY_UNAVAILABLE`, and redemption returns `HOSTED_ADMISSION_CLOSED` and
leaves the invite unconsumed. Keep a place free before you invite an app
directory reviewer.

The authenticated API is the non-browser fallback. Keep the operator token out
of logs and chat transcripts:

```bash
curl --fail-with-body \
  -X POST "$EXOMEM_PUBLIC_BASE_URL/api/exomem/admin/invites" \
  -H "Authorization: Bearer $EXOMEM_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"email":"invitee@example.com","kind":"standard"}'
```

`kind` is `standard`, `friend` or `covered`. A friend or covered invitation
also needs `inviterName`.

The response contains only an opaque invite ID and request ID. Brevo sends the
token in the URL fragment, so request logs never contain it. A complimentary
redemption creates a cell row with `desired_state = running`.

### A first subscription that disagrees with its checkout

Checkout sells the friend price only to a tenant that holds a friend offer.
When Paddle reports a new subscription whose friend price disagrees with
that, the web app logs `exomem_paddle_friend_price_mismatch` with the tenant
ID. It activates the subscription as Paddle reports it and records no friend
offer from it. Compare the subscription's price and discount in the Paddle
dashboard with the tenant's checkout, and correct the subscription there.

### Remove a friend price

A tenant's friend offer makes every later checkout carry the friend discount.
To end an owner's friend price:

1. Remove the friend discount from the owner's subscription in the Paddle dashboard.
2. Wait until the account no longer shows the friend price. Home's plan row
   drops "friend price", and this statement returns a discount other than the
   friend discount, or none:

   ```sql
   SELECT provider_discount_id FROM exomem_entitlements WHERE tenant_id = '<tenant id>';
   ```

3. Run this statement against the production database, with the owner's tenant ID:

   ```sql
   UPDATE exomem_tenants SET friend_offer_invite_id = NULL, updated_at = now()
   WHERE id = '<tenant id>';
   ```

Do step 3 only after step 2. Until the account stores Paddle's event without
the discount, a delayed Paddle event that still carries the discount can record
the offer again. Without step 3, a resubscribe after the subscription ends
charges the friend price again.

## Email delivery

Each Exomem email leaves a trail that an operator can read: whether the
provider accepted it, how long it waited in the queue, and what Brevo reported
afterwards. Three records make it up.

- The outbox row of each email stores Brevo's message id on acceptance, without
  the angle brackets Brevo wraps around it. Both outboxes do this:
  `exomem_email_outbox` and the magic-link `exomem_access_delivery_outbox`.
- `exomem_email_provider_events` stores one row per Brevo event for a message:
  the id, the event name and its time. It stores no address, subject, reason
  text or IP. A repeated event changes nothing. The access-delivery job deletes
  rows 30 days after receipt.
- Content-free operational events: `access.email.accepted` (with `emailKind`,
  `attempts` and `queueMs`), and `access.email.delivery_failed` and
  `access.email.cancelled` (with `emailKind` and `errorCode`). A magic link
  logs `access.magic_link.sent` and `access.magic_link.delivery_failed` the
  same way. Each canary run logs `access.start.canary_checked`; see
  "Functional health".

### Measured delivery times

Measured read-only on production on 2026-11-12. From a row's creation to
Brevo's acceptance, over 30 days: waitlist emails took a median of 185 seconds
and a 95th percentile of 268 seconds (11 emails). One covered invitation took
153 seconds. The rows waited for the minute job. From Brevo's `request` to
`delivered`, over 7 days: 0.4 to 7 seconds, with no bounces.

Immediate dispatch of request-time emails targets seconds. Treat that as a
target until the delivery report below shows it. The report is the instrument.

### Register the Brevo webhook

Do this once per Brevo account, after the release that contains the receiver.
Until it runs, the report shows delivery as unknown.

1. Make a random token of at least 32 bytes, for example with `openssl rand -base64 32`.
2. Set `BREVO_WEBHOOK_TOKEN` to that token in the web app's production environment, and redeploy.
3. Send `POST https://substratesystems.io/api/webhooks/brevo` with no token. Expect `401`. A `503` means the token is not deployed.
4. Register the webhook with the command below. It needs `BREVO_API_KEY` and `BREVO_WEBHOOK_TOKEN` in your shell.
5. Expect `201` and a body with the new webhook's `id`. Keep that `id`.
6. Send one start request from a test address you own. Wait one minute.
7. Read the delivery report. Expect `deliveryEvidence` to change from `none_received` to `received_partial_window`.

```bash
jq -n --arg token "$BREVO_WEBHOOK_TOKEN" '{type:"transactional",events:["request","delivered","deferred","softBounce","hardBounce","blocked","spam","invalid","unsubscribed"],url:"https://substratesystems.io/api/webhooks/brevo",auth:{type:"bearer",token:$token},description:"Exomem email delivery"}' | curl --fail-with-body -sS -X POST https://api.brevo.com/v3/webhooks -H "api-key: $BREVO_API_KEY" -H "content-type: application/json" -d @-
```

The receiver stores only these events: `request`, `delivered`, `deferred`,
`soft_bounce`, `hard_bounce`, `blocked`, `spam`, `invalid_email`, `error` and
`unsubscribed`. It answers `200` to every other event, such as an open or a
click, and stores nothing for it. It answers `400` to a body that is not JSON,
so Brevo discards it. It answers `5xx` only when our own storage fails, and
Brevo then retries after 10 minutes, 1 hour, 2 hours and 8 hours. To rotate the
token, set the new `BREVO_WEBHOOK_TOKEN`, redeploy, then update the webhook in
Brevo. Events that arrive in between get `401` and are lost.

### Read the delivery report

```bash
curl --fail-with-body -sS "$EXOMEM_PUBLIC_BASE_URL/api/exomem/admin/email-delivery?hours=24" -H "Authorization: Bearer $EXOMEM_ADMIN_TOKEN"
```

`hours` defaults to 24 and may be 1 to 168. The report names its window
(`window.from` to `window.to`) and its sources. For each kind of email, with
the magic link as its own kind, it gives:

- `queued`, `sent`, `failed` and `cancelled`: emails created in the window, by
  their state now. A magic link that a newer link superseded counts as failed.
- `pending` and `pendingPastDue`: emails that are unsent now, of any age, and
  the part of them that is ready and still unsent. `pendingPastDue` above zero
  for more than a few minutes means the drain is stalled.
- `queueToAccepted`: p50 and p95 from the email's first due time to Brevo's
  acceptance, with the number of emails measured. An email queued for later,
  such as a reminder, counts from its due time, so a due date days away is not
  a slow send. Rows from before the due time was recorded are not measured.
- `acceptedWithoutProviderId`: emails that Brevo accepted without a stored id.
  No Brevo event can be matched to them.
- `delivery`: counts of emails with a `delivered`, `deferred`, `softBounce`,
  `hardBounce`, `blocked`, `spam`, `invalid` or `error` event, and p50 and p95
  from acceptance to `delivered`, with the number measured.

The per-kind numbers leave out the sign-in canary's emails, which are not real
traffic. The `canary` section reports them. `canary.configured` is `false`, with
a `reason`, when `EXOMEM_HEALTH_START_CANARY_EMAIL` is unset. Otherwise
`canary.runs` lists the last 12 canary emails, newest first, with `queuedAt`,
`queueSeconds` (due to acceptance), `deliverySeconds` (acceptance to
`delivered`) and an `outcome`. A `pending` outcome means that no bound has
broken yet. A `failed` outcome carries `failure`: `not_accepted`,
`accepted_late` or `not_delivered`. `canary.bounds` gives the bounds in use.

Unknown is not zero. `delivery` is `null` while `deliveryEvidence` is
`none_received`: Brevo has never reported an event, so delivery is unknown.
`received_partial_window` means the first event arrived after the window began,
so delivery earlier in the window is unknown. A latency is `null` when no email
was measured. Brevo's `delivered` means the receiving server accepted the
message, not that a person read it.

## Account deletion

Home sends a fresh one-use email confirmation. Confirmation sets the tenant to
`deletion_pending`, revokes Exomem sessions and tokens, gates the entitlement,
and sets the cell row to `deleted`, which also revokes the tenant's OAuth
grants. The Cloud deletion finish then cancels the Paddle subscription and
scrubs the tenant in one transaction. The reconcile job retries both until they
succeed. Deletion never removes the shared `users` row or Endstate data.

A legacy Hosted tenant without a Cloud cell row stays `deletion_pending` after
confirmation, because no worker finishes it. Count such tenants before you rely
on deletion receipts:

```sql
SELECT count(*) FROM exomem_tenants AS tenant
WHERE tenant.status = 'deletion_pending'
  AND NOT EXISTS (SELECT 1 FROM exomem_cloud_cells AS cell WHERE cell.tenant_id = tenant.id);
```

Email 07 ("Your Exomem has been deleted") waits, with no deadline, until
cellctl reports every cell of the tenant deleted. A receipt that still waits
after 7 days means cellctl has not finished a deletion. To list those
receipts and the cells that hold them, run:

```sql
SELECT outbox.tenant_id, outbox.created_at AS queued_at,
       cell.cell_id, cell.desired_state, cell.observed_state,
       cell.generation, cell.observed_generation, cell.observed_at,
       cell.last_error_code
FROM exomem_email_outbox AS outbox
JOIN exomem_cloud_cells AS cell ON cell.tenant_id = outbox.tenant_id
WHERE outbox.kind = 'deleted'
  AND outbox.state = 'pending'
  AND outbox.created_at < now() - interval '7 days'
  AND (NOT exomem_cloud_cell_deletion_finished(cell) OR cell.observed_at IS NULL)
ORDER BY outbox.created_at;
```

The access-delivery job checks a waiting receipt every 5 minutes and sends it
once cellctl finishes. cellctl runs in Exomem, so investigate the cell there.
Do not edit the outbox row.

### Functional health

Public health readers certify the latest completed proof, rather than a responding process. Missing, failed, stale or unreadable proof returns HTTP 503 with `{"ok":false}`. Fresh successful proof returns HTTP 200 with `{"ok":true}`. Readers disable caching and perform no sends or writes.

| Public route              | Checked scope                                                                | Schedule                     | Default freshness |
| ------------------------- | ---------------------------------------------------------------------------- | ---------------------------- | ----------------- |
| Control `/healthz`        | PostgreSQL temporary-row write/read                                          | Each minute                  | 180 seconds       |
| Control `/healthz/email`  | A canary start accepted and delivered, and no stalled or failed queued email | Each 30 minutes              | 3,600 seconds     |
| Gateway `/healthz/canary` | One synthetic cell's mutable-page write/read                                 | Platform CronJob each minute | 180 seconds       |

The email proof starts a sign-in the way a person does, and checks that the
email arrives. Every 30 minutes it requests a start for
`EXOMEM_HEALTH_START_CANARY_EMAIL` through the same server function the start
route calls. It skips only the browser bot check, which no script can pass, and
only inside this scheduler-authenticated route: no public route reaches that
path. The canary uses its own network key, `health-canary`, so it never shares a
rate-limit bucket with a real client. The request queues one waitlist email, and
the proof sends it before the run ends. Each run:

1. Judges the newest canary email that is at least
   `EXOMEM_HEALTH_CANARY_DELIVERY_SECONDS` old, which is normally the previous
   run's. Brevo must have accepted it within `EXOMEM_HEALTH_CANARY_QUEUE_SECONDS`
   (default 60) after its due time, and must have reported it `delivered` within
   `EXOMEM_HEALTH_CANARY_DELIVERY_SECONDS` (default 600) after accepting it. A
   `delivered` event that never arrives fails the proof, so a stopped Brevo
   webhook fails it too. Judging only emails whose bound has run out means that
   a scheduler retry, seconds after a run, reaches the same verdict instead of
   judging the email that the first attempt just sent.
2. Sends a new canary, and takes the result from this run's own start. The
   start must queue a waitlist email that Brevo accepts with a message id in
   the same run. If the same fixed 15-minute window already queued its reply,
   the start queues nothing new, and the run reads that email: it passes only
   when Brevo accepted it with a message id. Nothing is inferred from an
   earlier email's age.
3. Reads real traffic, as the next paragraph says.

A run with no canary email that old, such as the first, passes on its own
acceptance.

Every database transaction and statement that the run makes, including the
owner lookup that the start request makes first, ends a wait for a lock after
2 seconds and a statement after 3 seconds. Real start requests set no limits.
The run stops its own work at 10 seconds and opens no new transaction after
that. A wait for a free database connection ends at the deadline too, and a
connection that arrives later goes back to the pool unused. The run waits up to
4 seconds for the transaction in flight to end, then saves a failed proof, so it
ends inside the scheduler's 20 seconds with no canary transaction left open. A
held lock, such as the Cloud capacity lock or a lock on the tenants table, or a
pool with no free connection, therefore fails the proof with `CANARY_TIMED_OUT`
instead of hanging the run.

Each run logs one `access.start.canary_checked` event. `queueMs` is this run's
canary, from due time to acceptance. `deliveryMs` is the previous canary, from
acceptance to `delivered`; it is absent while that is unknown. On failure,
`errorCode` is one of the following. The event holds no address.

- `CANARY_NOT_CONFIGURED`: the address is unset or not an email address.
- `CANARY_ADDRESS_HAS_ACCOUNT`: the address owns an account, and the start
  queued a real sign-in link. Change the address.
- `CANARY_ADDRESS_HAS_INVITATION`: the address holds an open operator
  invitation. Revoke it or change the address.
- `CANARY_NOT_QUEUED`: a rate limit refused the start, so it queued nothing.
- `CANARY_START_FAILED`: the start threw. Read the `access.start.failed` event.
- `CANARY_TIMED_OUT`: the run hit its 10-second deadline, or a lock or
  statement wait hit its limit.
- `CANARY_NOT_ACCEPTED`, `CANARY_ACCEPTED_LATE` and `CANARY_NOT_DELIVERED`:
  Brevo did not accept this run's canary, or the email of this window that a
  repeated start found, or the judged canary broke its bound.
- `EMAIL_DELIVERY_UNAVAILABLE`: real traffic stalled.
- `INTERNAL_ERROR`: another failure.

The canary address must have no Exomem account, because an address that has one
gets a real sign-in link every 30 minutes. It must also be an address that the
mail host accepts and drops: an unlisted address on our own domain, such as a
catch-all rule that discards. An address that bounces never reports `delivered`
and fails the proof. The canary takes a waitlist place for that one address and
never a Cloud place: the shared start path always queues the address on the
waitlist, whoever asks and in any admission mode, and never issues it a start
link. It is also left out of waitlist promotion and out of the check for people
waiting. Its emails are not in the delivery report's per-kind
numbers; the report's `canary` section lists them.

Brevo's free plan allows 300 emails a day across all mail. The canary sends 48 a
day, one every 30 minutes, which leaves 252 for real mail. Do not slow the
schedule: email freshness cannot exceed one hour, and a run every hour leaves
no room for a late one. `EXOMEM_HEALTH_EMAIL_RECIPIENT` is retired. Nothing
reads it, so remove it from the production environment.

The email proof also reads real traffic in both outboxes. It fails when an
email is ready but unsent more than `EXOMEM_HEALTH_EMAIL_OVERDUE_SECONDS`
(default 300) after its due time, or when an email failed in the last hour for
a reason other than the provider refusing it. A cancelled email never fails the
proof, and neither does a refusal, which is a bad request and not an outage.
A sign-in link that was replaced by a newer one, or that could no longer be
used, does not fail the proof either; any other sign-in link failure does.
The proof runs every 30 minutes, so a stall raises the alert between 5 and 35
minutes after it starts. An email in retry backoff counts only when its next
attempt is overdue, or when it fails for good. The value must be a positive
whole number of seconds. The delivery report, in "Email delivery" above, shows
the detail.

These checks do not certify inbox placement at other mail providers, OAuth issuance, semantic recall or every customer cell. Functional failure does not gate admission or restart pods. Direct gateway `/healthz` and `/readyz` retain their pod probe semantics.

The public gateway ingress must allow GET only and rewrite `/healthz` to `/healthz/canary`. Pod probes bypass that rewrite. Until the rewrite and first proof exist, public memory status stays unavailable.

Freshness uses `EXOMEM_HEALTH_CONTROL_FRESHNESS_SECONDS`, `EXOMEM_HEALTH_EMAIL_FRESHNESS_SECONDS` and `EXOMEM_HEALTH_MEMORY_FRESHNESS_SECONDS`. Each value must be a positive integer. Email freshness cannot exceed one hour.

The protected control and email routes are `/api/cron/exomem-health-control` and `/api/cron/exomem-health-email`. Both use the existing dedicated scheduler bearer. Email requires `EXOMEM_HEALTH_START_CANARY_EMAIL`, an address with no account that the mail host accepts and drops.

The gateway image includes `gateway/memory-health-runner.cjs`. Its one-shot CronJob requires these values:

| Variable                             | Meaning                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                       | Dedicated runner role's proof database connection                                                  |
| `EXOMEM_HEALTH_MEMORY_MCP_URL`       | Only the dedicated synthetic cell's MCP endpoint                                                   |
| `EXOMEM_HEALTH_MEMORY_BEARER`        | Only that cell's bearer; never the shared signing key                                              |
| `EXOMEM_HEALTH_MEMORY_PAGE`          | One mutable synthetic page with a unique `exomem_id`                                               |
| `EXOMEM_HEALTH_MEMORY_BODY_TEMPLATE` | A valid page body containing `{{nonce}}`; its semantic vocabulary follows the cell's configuration |
| `EXOMEM_HEALTH_MEMORY_TIMEOUT_MS`    | Total MCP budget; default 15,000, valid range 100–20,000                                           |

The runner validates `replace_body`, reuses its transition proof, commits the same body and reads the page. It compares the returned body with the fresh nonce body. It records one final proof per attempt and exits nonzero on failure. Proof storage contains only the component, run identity, start time, check time and success.

Migration0070 creates `exomem_record_memory_health_proof(uuid, timestamptz, timestamptz, boolean)`. It writes only the memory component, uses a fixed schema-qualified table, validates timestamps and cannot replace a newer attempt. The migration revokes public execution.

The deployment owner provisions roles and grants through the normal platform release. The runner role gets CONNECT on the database, USAGE on the application schema and EXECUTE on that exact function. It gets no proof table grant. The public gateway reader gets SELECT on `exomem_health_proofs` and no execution grant on the function. The existing control writer retains its ordinary application authority.

The platform packet must provide the runner's synthetic-only network allowance, minute schedule and command. It must synchronize the two HTTP jobs from `ops/exomem-hosted-schedules.json`. An actual scheduled proof remains a separate rollout check; source verification does not certify deployed health.

### Manual storage additions

Owners can add storage from Home when `EXOMEM_CLOUD_STORAGE_ENABLED=true`.
The default is off. `EXOMEM_PADDLE_STORAGE_PRICE_ID` identifies the recurring storage price in the configured Paddle environment.
The price's structured `custom_data.exomem_storage_bytes` gives bytes per unit.
Its `custom_data.exomem_storage_packs` array gives the offered quantities. Paddle supplies quantity limits, prices and tax.

1. Apply migration 0071 through the normal web deployment, to create paid operations and capacity fields.
2. Deploy the companion controller observation change, to report the bound claim's actual capacity.
3. Check the price metadata and controller receipts, to confirm that the environment supports the purchase.
4. Enable the feature through the normal release process, to expose the storage panel on Home.

The panel previews the immediate charge and recurring total before one confirmation.
A declined card uses the subscription's payment-method form. The owner then checks and confirms a fresh price.
An unknown provider result stays pending. Reopening the panel checks the existing operation; it does not repeat the charge.
Paid storage becomes complete only after the original claim reports sufficient capacity for the requested generation.
The desired-size change also changes the rendered cell template and restarts its serving pod during reconciliation.
Include that brief interruption in the controller rollout and feature-enablement window.

The application preserves paid allowance through later subscription events.
This flow does not buy storage automatically, reduce a volume or remove an add-on.
Those actions remain outside this capability.

## The gateway hold

When a cell refuses connections, for example during its upgrade, the gateway
holds a request and retries the same cell. It retries every
`EXOMEM_CLOUD_HOLD_INTERVAL_MS` plus up to `EXOMEM_CLOUD_HOLD_JITTER_MS`, until
`EXOMEM_CLOUD_HOLD_BUDGET_SECONDS` runs out. Then it answers `503
CELL_NOT_READY` with `Retry-After: EXOMEM_CLOUD_HOLD_RETRY_AFTER_SECONDS`.

- The gateway holds only a request whose body fits the 1 MiB prepared-body cap.
  A larger body streams to the cell and is never held.
- The gateway retries only when no connection opened. It never sends a request
  again after the cell could read it.
- A held request counts against `EXOMEM_CLOUD_HOLD_MAX` and
  `EXOMEM_CLOUD_HOLD_MAX_PER_TENANT`, not against the in-flight caps. When the
  cell accepts, the request needs a free in-flight slot, or it gets `429
RATE_LIMITED`.
- `EXOMEM_CLOUD_CONNECT_TIMEOUT_MS` bounds each connection attempt to a cell.
- A cell that sends no response headers within
  `EXOMEM_CLOUD_UPSTREAM_TIMEOUT_SECONDS` gets `504 CELL_TIMEOUT`.
- A response that sends no bytes for `EXOMEM_CLOUD_UPSTREAM_IDLE_SECONDS` is
  closed. Keep this value above the longest tool call.

To turn the hold off, set `EXOMEM_CLOUD_HOLD_BUDGET_SECONDS` to `0`. The
gateway then answers a refused connection with `503 CELL_NOT_READY` at once.

## Service notices

An operator declares planned maintenance or a known incident with one command.
Substrate does nothing by itself: no notice exists until you declare one. A
declared notice does four things.

- It emails the owner of each covered Exomem, once.
- It adds the header `x-exomem-service-notice` to each MCP request that goes to
  a covered cell, so the person's assistant can tell them.
- It lists the notice on the public status page.
- It ends when maintenance ends, when you cancel it, or when you resolve it.

### When to declare

- Declare maintenance for planned work that stops or slows Exomem Cloud, such
  as a cell release or a storage move. Declare it at least two days ahead.
  Substrate emails owners 48 hours before the start unless you set
  `--announce-from`.
- Declare an incident when you know of a problem that owners can feel. Resolve
  it when it is over.
- Declare nothing for a fault that nobody can feel.

### Write the summary

The summary is one line of plain text, at most 280 characters. The email, the
assistant's sentence and the status issue title all use it. The assistant's text
is capped at 400 characters in all, so a summary over about 200 characters is
shortened there. The email and the issue title keep it whole.

1. Say what is affected, in the owner's terms, and what still works.
2. Say only what you know. Name no cause you have not confirmed and promise no time.
3. Name no person, tenant or cell.

Example: "Saving is slow. Recall works, and nothing is lost."

### Declare maintenance

Set `EXOMEM_PUBLIC_BASE_URL` and `EXOMEM_ADMIN_TOKEN` in your shell. Sign in to
`gh` with an account that can write to the status repository.

1. Run `gh auth status`. Expect your account and no error.
2. To cover the whole fleet, run the command below. Add `--cell <cell-id>` once per cell to cover only some.
   ```bash
   npx tsx scripts/exomem-service-notice.ts create maintenance --summary "Saving may pause for a few minutes while we move storage." --starts 2026-12-01T02:00:00Z --ends 2026-12-01T02:30:00Z --line website-and-sign-in
   ```
3. Read the owner count and the assistant's sentence. Type `y` to confirm.
4. Expect `Created maintenance notice <id> (scheduled).` and the URL of the status issue.

To see the owner count and the sentence without creating anything, use `preview`
in place of `create`. `--line` names the status lines that the issue lists as
expected to be down. `--no-mirror` skips the status page.

### Declare an incident

1. Run the command below. `--line` is the slug of the affected status line, as the status site shows it.
   ```bash
   npx tsx scripts/exomem-service-notice.ts create incident --summary "Saving is slow. Recall works, and nothing is lost." --line website-and-sign-in
   ```
2. Read the owner count and the sentence. Type `y` to confirm.
3. When the problem is over, run the command below with the notice id from `list`.
   ```bash
   npx tsx scripts/exomem-service-notice.ts resolve <notice-id> --account "Storage was slow for 40 minutes after a disk filled; we cleared it."
   ```
4. Expect `Resolved notice <id>.` and `Closed status issue`. Covered owners get one email that says the problem is resolved.
   The status monitor can close an incident issue itself when its check recovers. The command then
   prints `was already closed; added the comment to it` and still exits 0.

### Fix a wrong notice

- To correct a wrong time or wrong cells, cancel the notice and declare a new one.
  Run `npx tsx scripts/exomem-service-notice.ts cancel <notice-id>`.
- A cancelled or started maintenance sends no further emails. An email that has
  already gone cannot be recalled. Tell owners on the status page.
- `npx tsx scripts/exomem-service-notice.ts list` shows each notice, its state and its id.

### What each person sees

- An owner gets one email for maintenance and one when an incident is resolved.
  The email states the times in the owner's time zone, your summary and the
  status page address. The delivery job sends 20 emails a minute, so declare
  early for a large fleet: a maintenance email not sent by the start is dropped.
  An incident email goes only to owners whose cell existed when you resolved the
  incident, so a cell created later gets none.
- A person's assistant gets an instruction to tell the person once in the
  conversation, with the times in UTC, your summary and the status page address.
  A cell shows it only after the Exomem cell release that reads the header;
  older cells ignore it.
- Substrate sets the header and refuses a caller's own `x-exomem-` header.
  A gateway instance keeps its copy of the notices for 30 seconds. The first
  request after that waits for one refresh, at most 1 second, and carries the
  result, so a request never carries a notice that changed more than 30 seconds
  ago. An instance with no traffic asks the database nothing.
- The status page shows maintenance under scheduled maintenance, with its start
  and end, and an incident under its status line.

### Configuration and grants

- `EXOMEM_STATUS_REPO` names the status repository for the script. Default
  `substrate-systems/exomem-status`.
- `exomem_gateway` has `SELECT` on `exomem_service_notices` and
  `exomem_service_notice_cells`, applied by `scripts/exomem-cloud-grants.sql`
  after each migration run.
- If the gateway logs `exomem_cloud_gateway_service_notices_unavailable`, it
  sends no notice and serves every request as before. It tries again once every
  30 seconds, and requests carry no notice until a lookup works. Check the grants
  and the database connection.

## Monthly What's new email

Once a month each owner whose setting is on gets one email of the month's
most noticeable changes, only those that their cell already runs. The daily
route `/api/cron/whats-new-digest` builds the previous month; the operator
approves it on `/exomem/operator/whats-new`; the per-minute delivery job
(`/api/cron/exomem-access-delivery`) then queues the owners, 200 a tick, and the
outbox sends each digest after every other queued email.

Before the first month sends:

1. Set `EXOMEM_WHATS_NEW_FIRST_MONTH` to the month before the one in which
   Evermatter's notes-file change ships. That change attaches the file to every
   release published since the start of the previous UTC month, so it heals the
   older releases of that month. The change is still in review in Evermatter; a
   month that is built before it ships waits and names the releases without a file.
2. Set `EXOMEM_WHATS_NEW_GITHUB_TOKEN`.
3. Set `EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY`.
4. Open `/exomem/operator/whats-new` and check that its Setup rows name no
   setting as not set or malformed.

To rotate the unsubscribe key:

1. Generate a new key as the control-plane key is generated.
2. In Vercel, set the new value as `EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY` and the old value as `EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY_PREVIOUS`, then redeploy.
3. Open a recent digest's unsubscribe link and check that the page accepts it.
4. Remove `EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY_PREVIOUS` only when no owner needs the links of older emails; they carry no expiry.

Only the current key signs a new link. Both keys verify while the previous one is set. A previous key that is malformed is ignored when links are checked, as the other `_PREVIOUS` keys are, so links signed with the current key keep working. The approval page names it, and an approved month queues nothing until the key is fixed or removed. Expected result: an old link and a new link both turn the setting off.

Each owner has a "Monthly update email" setting on Home. It is off for every
owner who existed before the email shipped, and Home invites each of them once.
It starts on for a new owner whose signup showed the switch and left it on; a signup request that states no choice starts it off. Every digest carries
a one-click unsubscribe (`List-Unsubscribe` and `List-Unsubscribe-Post`). A POST
to its address turns the setting off; a GET changes nothing.

The operator can stop a month that is ready to queue or queued with "Stop sending this month" on the page. The month becomes skipped, the delivery job queues no more of it, and a digest still waiting in the outbox is cancelled when it would send. A digest that Brevo already accepted cannot be recalled. With the operator's switch on, a built month waits 24 hours as "ready, sends after <time>" before anything queues, so the stop window opens before the first digest.

The daily route stops calling GitHub and the model before its 60-second function limit (the Vercel Hobby ceiling) and leaves the month waiting; the next daily run resumes from the month's record. A month that waits is visible on the page with its last check time.

Before the first real send, read the received test message's headers: its `DKIM-Signature` `h=` list must cover `List-Unsubscribe` and `List-Unsubscribe-Post`, and the message must carry one `List-Unsubscribe` header, not a second one from Brevo. RFC 8058 needs both, or a mailbox provider ignores the one-click.

To turn the setting on for one existing owner who asked for the email, POST the
owner's tenant id with the admin token. The owner's row keeps when it happened
and the operator principal's digest, and the log shows `operator.control` and
`whats_new_digest.owner_turned_on` for the request. The action turns the setting
on whatever the owner did before. Its answer carries `earlierUnsubscribedAt`, the
time an owner unsubscribed or turned it off, and `earlierDismissedInvitation`,
true for an owner who dismissed Home's invitation. Read them before you act: an
owner who said no earlier may not have meant to ask now. A signup that left the
switch off is not recorded, so the answer cannot report it:

```bash
curl -sS -X POST https://substratesystems.io/api/exomem/admin/monthly-update-email \
  -H "authorization: Bearer $EXOMEM_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"tenantId":"<tenant id>"}'
```

## Cloud releases

`PUT /api/exomem/admin/cloud-release` is the only writer of `cell_image`. Each
digest that becomes `cell_image` is recorded once in the image history, with
its release tag. A digest that is new to the history needs its `release`, a
`vMAJOR.MINOR.PATCH` tag.

The admin token may set any digest, clear a rollout pause and set one cell's
image. The deploy token, `EXOMEM_DEPLOY_TOKEN`, may only do these two things:

- read `GET /api/exomem/admin/cloud-release/rollout`;
- send `PUT /api/exomem/admin/cloud-release` with exactly `cellImage` and
  `release`.

| Answer                            | Meaning                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `409 CELL_IMAGE_SEEN`             | The deploy token sent a digest that was `cell_image` before. Nothing changed.                                                                                          |
| `409 CELL_RELEASE_OLDER`          | The deploy token sent a release older than the current `cell_image`'s release. Nothing changed.                                                                        |
| `403 OPERATOR_SCOPE_DENIED`       | The deploy token sent a field other than `cellImage` and `release`, or left one out. Nothing changed.                                                                  |
| `401` on the full `GET`           | The full view names every cell and tenant, so only the admin token reads it.                                                                                           |
| `500 CLOUD_CONFIGURATION_INVALID` | A Cloud setting is missing or malformed, such as an image repository with a tag or capitals. The `operator.control` log event's `variables` names it. Nothing changed. |

The rollout view holds no cell ID and no tenant ID, and its size does not grow
with the fleet. It returns `cell_image` and its `release`, `paused` and
`error_code`, and `canary_on_target`. The canary is the cell with the lowest
rollout priority; `canary_on_target` is true when that cell reports its target
image and is Ready. The `cells` counts give running and read-only cells on and
behind their target, cells under a hold, and `pinned_off_fleet`: running or
read-only cells whose pinned `desired_image` differs from `cell_image`.

### Seed the image history

Run the seed when Substrate first ships the image history, and again just
before you set `EXOMEM_DEPLOY_TOKEN`. The seed only adds rows, so a second run
changes nothing. It records every published release's cell image with its tag,
and every image that the Cloud tables name without a tag.

The script reads `DATABASE_URL`, `EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY` and
`EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY_PREVIOUS`. Load them into the shell for this
run only. Step 1 finds each release's image under the current repository first,
then under the previous one, because releases cut before the move were not
republished.

1. Build the release list from the published releases and their Cloud image digests:

   ```bash
   gh release list -R substrate-systems/evermatter --limit 1000 --json tagName --jq '.[].tagName' | while read -r tag; do for repo in "$EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY" "$EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY_PREVIOUS"; do digest=$(docker buildx imagetools inspect "$repo:${tag#v}-cloud" --format '{{json .Manifest}}' 2>/dev/null | jq -r .digest) && [ -n "$digest" ] && [ "$digest" != null ] && printf '{"release":"%s","image":"%s@%s"}\n' "$tag" "$repo" "$digest" && break; done; done | jq -s . > releases.json
   ```

2. Run `npx tsx scripts/seed-cloud-image-history.ts --releases releases.json` for a dry run. It prints counts only.
3. Check that `releases` equals the number of releases that published a Cloud image.
4. Run `npx tsx scripts/seed-cloud-image-history.ts --releases releases.json --commit`.
5. Read the rollout view with the admin token, and check that `release` names the live release.
6. Delete `releases.json`.

Expected result: a second dry run prints `added_from_releases=0 added_from_live=0`.

## Cell storage deletion

When Substrate deletes a cell it signs a deletion grant and stores it on the
cell's row. cellctl relays the grant to the Exomem executors, which purge the
cell's backups and media after the grant's `purge_after`, seven days after the
grant's `iat`. The database refuses any change to a deleted cell's desired
state, so a grant never loses its cell. `deletion_stopped_at` records when
cellctl's report that the cell is deleted first lands.

### The deletion-set endpoint

`GET /api/exomem/cell-deletions/<key-watcher capability>` returns every cell
deleted with a grant, each with `iat`, `purge_after` and `stopped_at`. It
accepts only the key-watcher receiver capability; every other caller gets the
alerts route's 404. Give the watcher the secret
`KEY_WATCHER_DELETIONS_URL` as
`https://<origin>/api/exomem/cell-deletions/<key-watcher capability>`, the same
capability whose digest sits in `EXOMEM_KEY_WATCHER_ALERT_TOKEN_SHA256`.

### Backfill deletion grants

Cells deleted before `EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY` went live carry
no grant, so nothing purges them. The backfill signs each missing grant, each
in its own transaction, and starts a full seven-day grace. Run it only at the
Exomem rollout's step 10, after the rehearsal, with operator approval.

The script reads `DATABASE_URL` for the production connection and
`EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY` for the signing key. Load both into
the shell for that run only, and never write either to a file.

1. Confirm `EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY` is live in production.
2. Run `npx tsx scripts/backfill-cell-deletion-grants.ts` for a dry run. It prints `missing` and `signed` counts only.
3. Check the `missing` count against the deleted cells you expect.
4. If the count matches, run `npx tsx scripts/backfill-cell-deletion-grants.ts --commit` to sign and store the grants.
5. Query the deletion-set endpoint and confirm every deleted cell appears with its `purge_after`.

Expected result: `signed` equals `missing`, and the deletion set lists every
deleted cell with a `purge_after` seven days after its grant's `iat`.
