# Staging

Staging is `https://staging.substratesystems.io`. It runs any branch that you push to
the `staging` branch, with sandbox Paddle and its own database. It holds no production
secret.

Use staging for three checks:

- The money path on sandbox Paddle.
- Email delivery to a real test inbox.
- Pages on a phone.

Staging has no cells and no gateway. An account stops at "getting ready".

## Deploy

1. Make sure the candidate branch contains the current `vercel.json`. Vercel reads
   `git.deploymentEnabled` from the pushed branch, so an old branch without `staging: true`
   does not deploy.
2. Run `git push --force-with-lease origin <candidate>:staging`.
3. Watch the deployment in Vercel. The build runs `scripts/vercel-maybe-migrate.ts`,
   which migrates the staging database only for `VERCEL_ENV=preview` on branch `staging`.
   It stops the build when `EXOMEM_CONTROL_PLANE_KEY` is missing or malformed.

Result: the deployment is live at the staging domain. Every other branch still creates no
preview, and no other preview ever migrates a database.

## Environment

Scope every variable below to the Vercel **Preview** target and branch `staging` only.
Vercel's production target keeps its own values.

| Variable                                             | Value and source                                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                       | Connection string for role `staging_app` through PgBouncer alias `substrate_staging`.           |
| `DATABASE_MIGRATION_URL`                             | Connection string for role `staging_owner` through PgBouncer alias `substrate_staging_session`. |
| `EXOMEM_CONTROL_PLANE_KEY`                           | New 32 random bytes as unpadded base64url. Never the production key.                            |
| `EXOMEM_ADMIN_TOKEN`                                 | New random token of at least 32 bytes. Held in BWS (`contracts/bws-exomem-staging-v1.json`).    |
| `EXOMEM_HOSTED_SCHEDULER_SECRET`                     | New random secret. The scheduler command below sends it.                                        |
| `EXOMEM_PUBLIC_BASE_URL`                             | `https://staging.substratesystems.io`                                                           |
| `PADDLE_ENVIRONMENT`                                 | `sandbox`                                                                                       |
| `NEXT_PUBLIC_PADDLE_ENVIRONMENT`                     | `sandbox`                                                                                       |
| `EXOMEM_PADDLE_CATALOG_ENVIRONMENT`                  | `sandbox`                                                                                       |
| `PADDLE_API_KEY`                                     | Sandbox API key (`pdl_sdbx_...`) from the Paddle sandbox dashboard.                             |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`                    | Sandbox client-side token (`test_...`) from the same dashboard.                                 |
| `EXOMEM_PADDLE_PRODUCT_ID`, `EXOMEM_PADDLE_PRICE_ID` | The sandbox product and its price.                                                              |
| `EXOMEM_PADDLE_FRIEND_DISCOUNT_ID`                   | The sandbox recurring discount that carries the friend price.                                   |
| `PADDLE_WEBHOOK_SECRET`                              | Secret of the sandbox notification destination below.                                           |
| `BREVO_API_KEY`                                      | Brevo key for the test sender. Held in BWS. Set `BREVO_SENDER_EMAIL` if the sender differs.     |

The code rejects a live Paddle key or token under `PADDLE_ENVIRONMENT=sandbox`
(`EXOMEM_PADDLE_ENVIRONMENT_MISMATCH`), which is the last guard against a mix-up.

Two requested settings have no variable in the code on `main`:

- **Turnstile:** no code reads a Turnstile variable yet. When it lands, use Cloudflare's
  Turnstile test keys or a staging-only widget, scoped like the rows above.
- **Admission mode:** admission is by invite redemption, with no mode variable. Create
  staging invites through the operator page with `EXOMEM_ADMIN_TOKEN`.

**Rule:** no production value may reach the Preview target. Do not copy a production
variable to it. Production's `DATABASE_URL` and `DATABASE_MIGRATION_URL` stay
scoped to the Production target, which is why a staging build cannot reach the production
database.

## Database setup

The migration runner grants table access only to roles `substrate_app` and `substrate_owner`
(`scripts/exomem-cloud-grants.sql`). Staging uses other roles, so grant them once, before the
first deploy, and again after every reset.

1. Set `STAGING_OWNER_URL` to the `staging_owner` URL for alias `substrate_staging_session`.
2. Run the command in "Reset" below on an empty database. It prepares the schema and the
   default privileges.

Result: tables that the build migrates are readable and writable by `staging_app`. The cell
tables get the same broad grant, because staging has no cells and no cell role.

## Paddle sandbox notification destination

Create it in the Paddle **sandbox** dashboard under Developer tools, Notifications.

- **URL:** `https://staging.substratesystems.io/api/webhooks/paddle`
- **Secret:** copy it to `PADDLE_WEBHOOK_SECRET`, then redeploy.
- **Events:** subscribe to these. The route (`src/app/api/webhooks/paddle/route.ts`)
  acknowledges and ignores any other event with `200`.
  - `subscription.created`
  - `subscription.activated`
  - `subscription.trialing`
  - `subscription.updated`
  - `subscription.past_due`
  - `subscription.paused`
  - `subscription.resumed`
  - `subscription.canceled`

The route verifies the `Paddle-Signature` header against `PADDLE_WEBHOOK_SECRET`.

## Scheduler

Staging has no always-on tick. While a test session runs, start this loop in a terminal.
It calls both scheduled routes every minute, as the production scheduler does
(`ops/exomem-hosted-schedules.json`). Stop it with Ctrl-C.

```sh
while true; do for r in exomem-access-delivery exomem-reconcile; do curl -sS --max-time 20 -H "Authorization: Bearer $EXOMEM_HOSTED_SCHEDULER_SECRET" "https://staging.substratesystems.io/api/cron/$r"; echo; done; sleep 60; done
```

Set `EXOMEM_HOSTED_SCHEDULER_SECRET` in the shell to the staging value first. Each call
returns `200` with a JSON summary. Access emails and awaiting-checkout expiry wait for this loop.

## Reset

This empties the staging database and prepares it for the next deploy. The statement stops
when the connection is not on `substrate_staging`, so it cannot run on production.

```sh
psql "$STAGING_OWNER_URL" -v ON_ERROR_STOP=1 -1 -c 'DO $$ BEGIN IF current_database() <> $q$substrate_staging$q$ THEN RAISE EXCEPTION $q$not the staging database$q$; END IF; END $$; DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION staging_owner; GRANT USAGE ON SCHEMA public TO staging_app; ALTER DEFAULT PRIVILEGES FOR ROLE staging_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staging_app; ALTER DEFAULT PRIVILEGES FOR ROLE staging_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO staging_app'
```

Then push the branch to `staging` again. The build re-applies every migration.
Result: `schema_migrations` and all tables exist again and hold no rows.
