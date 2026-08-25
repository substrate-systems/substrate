# Exomem Hosted staging

This is the permanent no-real-money release surface for the paid private alpha.
It uses the existing Substrate Vercel project and application, but its Git
branch, domain, Postgres schema boundary, Paddle Sandbox account resources, secrets,
sessions, invitations, and capacity ledger are isolated from production.

The fixed deployment identity is:

| Boundary           | Staging value                                                          |
| ------------------ | ---------------------------------------------------------------------- |
| Git branch         | `staging`                                                              |
| Vercel environment | Preview, restricted to `staging`                                       |
| Public origin      | `https://staging.substratesystems.io`                                  |
| Postgres boundary  | database `exomem_restore_verification`, schema `exomem_hosted_staging` |
| Paddle environment | `sandbox`                                                              |
| Paddle webhook     | `https://staging.substratesystems.io/api/webhooks/paddle`              |
| Hosted capacity    | 5 GiB storage, one runtime slot, one reservation, one claim            |

Do not add a second Vercel project. Do not point an arbitrary Preview at these
values. Do not copy a Paddle Live API key, client token, webhook secret, product,
price, transaction, customer, or subscription into staging.

## 1. Create and migrate the isolated schema

Connect to the approved Neon maintenance database as the `substrate` owner and
verify `current_user` and `current_database()` before creating anything. The
database is the existing non-production `exomem_restore_verification`; its
pre-existing `public` fixtures remain untouched. Create the staging schema once:

```sql
CREATE SCHEMA exomem_hosted_staging AUTHORIZATION substrate;
```

Construct the staging connection string from the **unpooled** Neon hostname with
the non-production database path and URL-encoded
`options=-c search_path=exomem_hosted_staging,public`. The staging schema stays
first so all application tables land there; `public` remains visible only for
installed extension types such as `citext`. Neon pooler endpoints reject this
startup option. Store the URL as a separate BWS secret; never write it to this
repository or a shell command. Apply migrations explicitly:

```bash
DATABASE_URL='<from approved secret channel>' npm run migrate
```

The Vercel build repeats pending migrations only when all staging guards agree:

- `VERCEL_ENV=preview` (set by Vercel);
- `VERCEL_GIT_COMMIT_REF=staging` (set by Vercel);
- `EXOMEM_HOSTED_STAGING=true`;
- `EXOMEM_HOSTED_STAGING_DATABASE_NAME=exomem_restore_verification`;
- `EXOMEM_HOSTED_STAGING_SCHEMA_NAME=exomem_hosted_staging`; and
- the `DATABASE_URL` path and `options` select exactly that database and schema.

A partial or mismatched staging contract fails before migration and prints no
connection string. Production keeps its existing production-only migration
behavior. Ordinary Preview builds still skip migrations.

## 2. Prepare Paddle Sandbox

In Paddle Sandbox, create or reuse one active `Exomem Hosted` SaaS product and
one active recurring price with exactly these facts:

- EUR;
- amount `500` in the lowest currency unit;
- interval `month`;
- frequency `1`.

Create a Sandbox client-side token and a Sandbox API key that can read products
and prices, create/read/cancel transactions, read subscriptions/customers, and
create customer-portal sessions. Create one notification destination at the
staging webhook URL above for transaction and subscription lifecycle events.
Keep the returned endpoint secret separate from every Live webhook secret.

Before enabling checkout, run the redacted catalog gate with the exact staging
environment injected from the approved secret channel:

```bash
npm run exomem:catalog:check
```

The only acceptable enabled result is `sandbox`, active product and price,
`EUR`, `500`, `month`, frequency `1`. The command never prints catalog IDs or
credentials. Removing `EXOMEM_PADDLE_PRICE_ID` is the checkout kill switch; the
command then reports `checkout disabled` while webhook, reconciliation, portal,
and deletion credentials remain available.

## 3. Configure the branch-bound Vercel Preview

Link this checkout to the existing Substrate Vercel project. Add or update every
override below for Preview branch `staging` only. `vercel env add NAME preview
staging` reads the value interactively or from standard input; never put a secret
value after `echo` or in command history.

Staging-only values:

| Variable                              | Value/authority                             |
| ------------------------------------- | ------------------------------------------- |
| `DATABASE_URL`                        | isolated staging database secret            |
| `EXOMEM_HOSTED_STAGING`               | `true`                                      |
| `EXOMEM_HOSTED_STAGING_DATABASE_NAME` | `exomem_restore_verification`               |
| `EXOMEM_HOSTED_STAGING_SCHEMA_NAME`   | `exomem_hosted_staging`                     |
| `EXOMEM_PUBLIC_BASE_URL`              | `https://staging.substratesystems.io`       |
| `EXOMEM_MCP_ALLOWED_ORIGINS`          | `https://staging.substratesystems.io`       |
| `EXOMEM_ADMIN_TOKEN`                  | fresh staging-only random secret            |
| `EXOMEM_CONTROL_PLANE_KEY`            | fresh staging-only 32-byte base64url secret |
| `EXOMEM_HOSTED_SCHEDULER_SECRET`      | fresh staging-only random secret            |
| `PADDLE_ENVIRONMENT`                  | `sandbox`                                   |
| `PADDLE_API_KEY`                      | Paddle Sandbox API key                      |
| `PADDLE_WEBHOOK_SECRET`               | staging Sandbox notification secret         |
| `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`     | Paddle Sandbox client token                 |
| `NEXT_PUBLIC_PADDLE_ENVIRONMENT`      | `sandbox`                                   |
| `EXOMEM_PADDLE_CATALOG_ENVIRONMENT`   | `sandbox`                                   |
| `EXOMEM_PADDLE_PRODUCT_ID`            | verified Sandbox product                    |
| `EXOMEM_PADDLE_PRICE_ID`              | verified Sandbox EUR 5 monthly price        |

Copy the current non-billing Hosted runtime configuration from production only
where the application needs the same implementation: provisioner endpoint and
credential, Cloudflare Access service token, transfer host, release/protocol and
worker settings, Brevo delivery settings, and any signing/catalog fixtures used
by the current cohort. Leave marketplace reviewer access disabled. The three
staging control-plane secrets above remain distinct even though the provisioner
endpoint is shared.

Push the intended release commit to the permanent `staging` branch. In Vercel
Project → Settings → Domains, add `staging.substratesystems.io`, select Preview,
and bind it to Git branch `staging` before relying on it. Vercel initially assigns
a newly added domain to the production branch, so this branch binding is a
mandatory stop-ship check. Redeploy after the domain and branch-scoped variables
are present.

## 4. Seed one staging slot

After the staging deployment is healthy, configure the existing capacity API
with the staging operator bearer:

```http
PUT /api/exomem/admin/capacity
Authorization: Bearer <staging operator token>
Content-Type: application/json

{
  "storageCapacityBytes": 5368709120,
  "runtimeCapacitySlots": 1,
  "provisionReservationCapacity": 1,
  "provisionClaimCapacity": 1
}
```

Read the capacity endpoint back. It must show the configured one-slot pool and
zero reserved/occupied usage before the proof starts.

## 5. Run the acceptance proof

Use one controlled staging email address and a clean browser:

1. Issue one paid operator invite. Before redemption, record production row
   counts so staging isolation can be checked without retaining identifiers.
2. Redeem it. Require one reserved allocation, `awaiting_checkout`, no lifecycle
   operation, and no provider resource.
3. Open checkout. Require the Sandbox overlay and a summary of EUR 5 monthly;
   stop if the environment or amount differs.
4. Pay with a Paddle Sandbox test card. Deliver the accepted event twice, then
   send one older subscription update. Require one applied, one duplicate, one
   stale disposition, and exactly one attached `initial-provision` operation.
5. Call the staging reconcile endpoint with the staging scheduler bearer until
   the real provisioner proves one ready cell. Never point the production K3s
   CronJob at staging and never mark the tenant ready by hand.
6. Connect a staging ChatGPT connector to the staging MCP resource. Capture one
   random sentinel, recall it in a fresh chat with a source, then delete the
   sentinel through governed Exomem operations.
7. Open the Paddle Sandbox customer portal from Home and verify the subscription
   appears. Do not cancel before the duplicate/stale and portal checks finish.
8. Delete the staging account through the normal owner workflow. Require Paddle
   Sandbox cancellation and provider destruction, then read capacity back to
   confirm the slot is released.
9. Re-read production counts. They must be unchanged apart from unrelated live
   traffic.

The evidence record may contain deployment revision, `sandbox`, stable outcome
codes, counts, and elapsed times. It must not contain an email, invite/session
token, tenant/allocation/operation/cell/provider ID, Paddle catalog/transaction/
customer/subscription ID, secret, or sentinel content.

## 6. Rollback

First remove the branch-scoped `EXOMEM_PADDLE_PRICE_ID` and redeploy. This stops
new checkout without disabling cleanup of an existing Sandbox transaction or
subscription. Finish or deliberately terminate the staging fixture through the
normal account lifecycle. Only then remove the staging branch domain or other
branch variables. Never delete staging database rows as a substitute for Paddle
cancellation or provider destruction.

This staging proof does not prove Paddle Live write permissions. Before the next
paid friend invitation, run the same catalog gate read-only against Live, verify
the checkout summary is €5, and cancel any abandoned Live draft transaction.
