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
redeploy. Never reuse a cell credential as a control-plane secret.

| Variable                                                            | Requirement                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                      | Postgres connection used by migrations and product-scoped rows.                                                                                                                                                                       |
| `EXOMEM_PUBLIC_BASE_URL`                                            | Production HTTPS origin, exactly `https://substratesystems.io`. Credentials, query, fragment and non-root paths are rejected, and there is no request-derived fallback. Development HTTP is loopback-only.                            |
| `EXOMEM_ADMIN_TOKEN`                                                | At least 32 random bytes, known only to operators. Protects the operator API and page.                                                                                                                                                |
| `EXOMEM_CONTROL_PLANE_KEY`                                          | Exactly 32 random bytes as unpadded base64url, on the web app and the gateway. Seals OAuth continuations and queued email links, and keys rate-limit buckets.                                                                         |
| `EXOMEM_CLOUD_MCP_URL`, `EXOMEM_CLOUD_MCP_PATH`                     | The Cloud MCP resource URL and its path on the gateway. The web app and the gateway must name the same resource. A missing value fails OAuth closed.                                                                                  |
| `EXOMEM_CLOUD_CELL_TOKEN_KEY`                                       | Gateway only: 32 bytes as hex, used to derive each cell's bearer. The web app does not need it.                                                                                                                                       |
| `CRON_SECRET`                                                       | Vercel-only bearer for unrelated daily and weekly jobs. Never install it in the K3s scheduler.                                                                                                                                        |
| `EXOMEM_HOSTED_SCHEDULER_SECRET`                                    | Dedicated active bearer shared only by the two Exomem scheduled routes and the K3s scheduler.                                                                                                                                         |
| `EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS`                           | Optional Vercel receiver-only overlap during rotation. Absent in steady state and never installed in K3s.                                                                                                                             |
| `EXOMEM_HOSTED_ALERT_TOKEN_SHA256`                                  | SHA-256 of the scheduler alert receiver capability for `/api/exomem/alerts/[token]`. Unset means the endpoint answers `404`. Only the digest belongs here.                                                                            |
| `EXOMEM_HOSTED_ALERT_TOKEN_SHA256_PREVIOUS`                         | Optional receiver-only overlap during alert capability rotation. A malformed value is ignored.                                                                                                                                        |
| `EXOMEM_HOSTED_ALERT_RECIPIENT`                                     | Optional alert address override; defaults to `founder@substratesystems.io`.                                                                                                                                                           |
| `BREVO_API_KEY`                                                     | Delivers invite, magic-link, deletion-confirmation, cancellation and alert email.                                                                                                                                                     |
| `BREVO_SENDER_EMAIL`, `BREVO_SENDER_NAME`                           | Optional verified sender overrides.                                                                                                                                                                                                   |
| `PADDLE_ENVIRONMENT`, `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`     | One matching Paddle environment, merchant API key and webhook-verification secret. Keep them configured after new checkout stops, so existing paid accounts can reconcile, manage billing and delete safely.                          |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`, `NEXT_PUBLIC_PADDLE_ENVIRONMENT` | Browser checkout token and the same environment as the merchant configuration. A mismatch fails closed.                                                                                                                               |
| `EXOMEM_PADDLE_CATALOG_ENVIRONMENT`, `EXOMEM_PADDLE_PRODUCT_ID`     | The environment and the Exomem product that the server selects.                                                                                                                                                                       |
| `EXOMEM_PADDLE_PRICE_ID`                                            | The price that checkout charges and Home shows. This is the new-checkout gate: remove it to stop new checkout.                                                                                                                        |
| `EXOMEM_PADDLE_DUNNING_DAYS`                                        | Days that Paddle retries a failed payment, as set in payment recovery. Home shows "read-only until" as the failed-payment start plus these days. Unset or outside 1 to 365, that date is unknown.                                     |
| `EXOMEM_PADDLE_FRIEND_DISCOUNT_ID`                                  | The recurring Paddle discount that carries the friend price. Home shows the friend price only on a subscription that carries this discount.                                                                                           |
| `EXOMEM_TURNSTILE_SECRET_KEY`                                       | Cloudflare Turnstile secret for "Start with your email". Unset, a secret that Cloudflare rejects, or a Cloudflare test secret in production leaves only the rate limits, and the web app logs `bot check unavailable` at error level. |
| `NEXT_PUBLIC_EXOMEM_TURNSTILE_SITE_KEY`                             | The matching Turnstile site key for the start form's widget.                                                                                                                                                                          |
| `EXOMEM_SELF_SERVE_ADMISSION`                                       | `closed` (default), `waitlist` or `open`. See "Start admission" below. Any other value reads as `closed`.                                                                                                                             |
| `OPENAI_APPS_CHALLENGE`                                             | Provider-issued single-line domain proof. Set it only in deployment configuration.                                                                                                                                                    |
| `EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED`                        | Leave unset or `false`. See `exomem-cloud-reviewer-access.md`.                                                                                                                                                                        |
| `EXOMEM_CONNECTOR_SETTINGS_URLS`                                    | Optional JSON object from client platform to the https page where its users manage connectors. The consent view offers it for "Connect after all". An unset or invalid entry offers no link.                                          |
| `EXOMEM_OAUTH_LAPSED_CONNECTOR_GRACE_HOURS`                         | Optional. Hours after its metadata expired before the sweep retires a connector that held a grant. Default 336 (14 days). A value that is not a whole number of at least 1 fails the sweep.                                           |
| `EXOMEM_OAUTH_IDLE_CLIENT_GRACE_HOURS`                              | Optional. Hours before the sweep retires a generic client holding nothing, or a connector with no grant since it registered. Default 24. A value that is not a whole number of at least 1 fails the sweep.                            |

Rate-limit bucket identifiers are domain-separated HMACs under the control-plane
key, never plain hashes of email or IP addresses. The access-delivery job prunes
buckets older than the longest window plus one hour, in bounded batches.

The anonymous interest endpoint, `/api/exomem/interest`, takes durable IP and
normalized-email buckets before it calls Brevo. A denied bucket returns `429`
with `Retry-After`. An unavailable limiter fails closed with `503`, so the
endpoint cannot spend the shared email quota. Add a Vercel edge or WAF rule for
that path as a burst-control layer. The rule must not log raw emails or IPs.

## OAuth and client admission

The authorization server metadata is at
`/.well-known/oauth-authorization-server/api/exomem/oauth`. The endpoints are
`/api/exomem/oauth/authorize`, `/token` and `/revoke`. Tokens are bound to
`EXOMEM_CLOUD_MCP_URL` by exact equality, and a grant always carries both
`exomem.read` and `exomem.write`. Token issuance requires a non-deleted cell
row for the tenant.

MCP bearer credentials belong only in the `Authorization` header. Never put
them in a URL, cookie, tool argument, log or cell header.

`EXOMEM_CONTROL_PLANE_KEY` has one envelope key and no key ID, so do not rotate
it in place. If it changes by accident, restore the exact old key before serving
traffic. Never rotate by deleting token, grant or family rows. Revoke a
compromised client family first. Use account-wide revocation only when every
client must re-authorize.

### Withdraw or revive a self-registering client

A client is admitted when it is enabled and either pinned or serving a valid
metadata document from a host in `exomem_oauth_admitted_cimd_hosts`
(`chatgpt.com` → `openai`, `claude.ai` → `claude`). Clients on an admitted host
register and refresh themselves on contact with `/authorize`. Generic clients
have their own lane; see "Generic MCP clients" below.

To withdraw one, delete its allowlist row. Setting `enabled = false` on the
client is not a durable off switch, because the next anonymous contact
re-enables it. Deleting the row for `claude.ai` withdraws every Claude client,
because claude.ai serves one global client document.

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

What the lane widens: any program can register and ask for authorization. The
invite stays the only way to a tenant. A generic client reaches an account only
when the person who signs in already owns one, or holds an unspent invite. PKCE
S256, exact redirect matching, single-use codes and resource binding apply as
for every other client.

Attribution is lost once the lane is enabled. Admission state cannot tell which
software wrote a memory. A generic client may name itself in `client_name`, and
nothing verifies that name: a generic client can call itself "Claude". The
consent page and Home must show the name as the client's own claim. A client
that declares no readable name has none stored.

Registration has these bounds:

- 5 registrations in 10 minutes per IPv4 address, or per IPv6 /64.
- The generic partition's bound of unretired clients, 50,000 at launch,
  counted apart from operator and CIMD clients. The sweep frees the slot of a
  generic client that has held nothing for its grace; see "Client slots and
  retirement". When the partition is full, every new registration is refused.
  Read it with `SELECT * FROM exomem_oauth_client_partitions();`.
- Every refusal answers `404` with an empty body, whatever the cause. The log
  event `exomem_oauth_register_rejection` names the stage, never a request value.

Deploy order: the web deploy applies migration 0062 and the grants script. The
gateway reads the lane on every token lookup, for every client. Roll a gateway
image that contains the generic arm only after that web deploy, or every MCP
call fails.

Enable the lane only when all of these are true:

- The deployed release retires idle generic clients
  (`reclaim-oauth-client-slots`, migration 0067), and the reconcile job's
  response includes `oauth.retiredGeneric`. Without slot reclaim, the
  partition fills once and stays full.
- Each OAuth client has a stored prominence context, coding or conversation,
  that its owner can change, and that defaults from the client's redirect
  shape. Today Substrate derives the context from the redirect URIs alone: an
  https redirect means conversation, and a loopback redirect means coding. That
  is right for every client admitted at launch, but it puts a desktop chat app
  with a loopback callback into coding.
- An independent review has checked that the consent page names the client
  and its scopes plainly, and shows the client's name as its own claim.
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

The document has no `registration_endpoint`, and the registration endpoint
answers `404`. Every generic client stops at every stage at once: authorization,
consent, token exchange, refresh and MCP calls through the gateway. Operator and
CIMD clients are not affected.

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
`exomem_oauth_client_partition_bounds`. The function
`exomem_oauth_client_partitions()` reads those rows, counts each partition, and
admission reads it. The first-party Home client takes no slot.

| Partition         | Launch bound | What one slot is                                           |
| ----------------- | ------------ | ---------------------------------------------------------- |
| `operator`        | 96           | A client that an operator registered by hand.              |
| `auto_registered` | 50,000       | One ChatGPT connector, or the one global claude.ai client. |
| `generic`         | 50,000       | One installed generic app, or one more registration of it. |

A bound limits two things: the clients connected at the same time, and the rows
that a registration flood can add before the sweep retires them. Each
self-registering bound is 50 clients for each of 1,000 accounts, because a heavy
user runs 15 to 25 apps or more at peak.

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

## Invitations

### Start admission

`POST /api/exomem/access/start` (and its earlier path `/access/magic-link`)
serves new and returning people. Every request that passes Turnstile gets the
same `202`, and the email carries the outcome. An owner gets a sign-in link.
Anybody else follows `EXOMEM_SELF_SERVE_ADMISSION`:

- `closed`: no email.
- `waitlist`: a waitlist place.
- `open`: a start link while Cloud has a free place and nobody is waiting,
  else a waitlist place. Each reconcile tick promotes the oldest waiting
  people into free places.

A free place is a freshly observed Cloud slot that no live cell and no unused
invitation holds. Every invitation counts, whatever its kind, and one address
counts once. Start links expire after 48 hours. A person who asks again while
they hold a live start link gets another link with the same expiry. Using any
of their links revokes the others. A waiting person who asks again keeps their
place and gets no second waitlist email.

Emails for start links, waitlist places, promotions and the unpaid-hold
reminder go through `exomem_email_outbox`. The access-delivery job sends at
most 20 per run, and retries an email until its own deadline. To see what is
stuck, run:

```sql
SELECT kind, state, last_error_code, count(*)
FROM exomem_email_outbox
WHERE state IN ('pending', 'leased', 'failed')
GROUP BY kind, state, last_error_code;
```

Retention runs on its own. The access-delivery job clears the address of an
outbox row 30 days after the row settles. The reconcile job deletes a
person's waitlist entry and unused start links 180 days after the later of
their last request and their last start link's expiry, unless the address
owns an Exomem. It keeps used start links and operator invitations. Account
deletion removes every outbox row for the owner's address.

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
   hostname is the public host.
4. Deploy with `EXOMEM_SELF_SERVE_ADMISSION` unset.
5. Request a sign-in link for an owner account from the start form. The
   owner receives one sign-in email.
6. Set `EXOMEM_SELF_SERVE_ADMISSION=waitlist`, then `open` when you want to
   admit people.

### Revoke historical self-serve invitations

The retired self-serve route returns `410`. It does not revoke an old bearer
that email already delivered. Run this procedure only before the first change
of `EXOMEM_SELF_SERVE_ADMISSION` away from `closed`. After that change, the
same rows are live start links, and this procedure revokes them. Count the
redeemable historical self-serve invites:

```sql
SELECT count(*) AS outstanding_historical_self_serve_invites
FROM exomem_invites
WHERE self_serve
  AND consumed_at IS NULL
  AND revoked_at IS NULL
  AND expires_at > now();
```

If the count is not zero, stop and revoke only that exact set in one
transaction. Keep the rows for audit:

```sql
BEGIN;
SELECT id FROM exomem_invites
WHERE self_serve AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
FOR UPDATE;

UPDATE exomem_invites
SET revoked_at = now()
WHERE self_serve AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
RETURNING id;
COMMIT;
```

Run the count again and require zero.

### Issue an invite

1. Open `/exomem/operator` directly; it is absent from public navigation and the sitemap.
2. Paste `EXOMEM_ADMIN_TOKEN` into the page. The page holds it only until refresh or "Lock".
3. Enter one email and leave "Paid" selected. "Complimentary" needs its own confirmation.
4. Send the invitation. The page then refreshes its capacity figures.

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
  --data '{"email":"invitee@example.com","source":"paid"}'
```

The response contains only an opaque invite ID and request ID. Brevo sends the
token in the URL fragment, so request logs never contain it. A complimentary
redemption creates a cell row with `desired_state = running`.

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
