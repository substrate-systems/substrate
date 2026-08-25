## Context

The paid private-alpha code is already environment-aware, and a disposable Paddle Sandbox proof has exercised it once. The missing piece is a durable deployment boundary: production currently owns the canonical domain, Postgres database, Paddle Live catalog, webhook, scheduler, and capacity ledger, while arbitrary Vercel previews are short-lived and intentionally skip migrations. A staging checkout must therefore be repeatable without becoming a second product stack or sharing billable records with production.

Vercel Hobby supports branch deployments and a custom domain assigned to a Git branch, but not custom environments. The existing Substrate project can still give the `staging` branch stable Preview configuration through branch-scoped environment variables. That avoids a fourth Vercel project and keeps deployment mechanics identical to production.

## Goals / Non-Goals

**Goals:**

- Keep one stable, no-real-money URL for the complete paid Hosted journey.
- Isolate database rows, sessions, invites, webhooks, and Paddle references from production.
- Reject a wrong product, inactive price, non-monthly interval, non-EUR currency, or amount other than 500 cents before a paid-enabled deployment becomes usable.
- Apply additive migrations to the staging database only from the exact staging branch contract.
- Reuse the existing application, Paddle adapter, provisioner protocol, and Vercel project.
- Produce a short, reproducible acceptance record without storing credentials or personal/provider identifiers.

**Non-Goals:**

- A second Vercel project, Pro custom environment, new billing provider, or staging-specific application fork.
- Public self-serve, fake provider responses, a production payment, or a permanent second production cluster.
- Duplicating the existing invite, entitlement, lifecycle, gateway, or customer-portal implementations.

## Decisions

### 1. Use a branch-bound Preview deployment in the existing Vercel project

The permanent branch is `staging`; `staging.substratesystems.io` is assigned only to that branch. Branch-scoped Preview variables set the public origin, database, Paddle Sandbox resources, scheduler/admin secrets, and existing provisioner credentials. Production variables remain untouched.

A separate Vercel project would duplicate domain and deployment configuration without improving isolation, because the important isolation boundaries are database and provider environment. A Pro custom environment is cleaner but not worth a paid platform upgrade during a four-person private alpha.

### 2. Give staging an isolated Postgres database/schema and one-slot ledger

Staging reuses the existing non-production `exomem_restore_verification` database and owns a fresh `exomem_hosted_staging` schema selected first in the connection `options` search path. The unpooled Neon hostname is required because its pooler rejects `search_path` startup options. The exact path is `exomem_hosted_staging,public`: staging tables, sessions, and migrations resolve into the first schema, while existing extension types remain visible from `public` and the earlier verification fixtures there stay untouched. The Vercel migration hook may run for a Preview only when all three facts agree: `VERCEL_ENV=preview`, `VERCEL_GIT_COMMIT_REF=staging`, and `EXOMEM_HOSTED_STAGING=true`. It also verifies that `DATABASE_URL` names both the configured staging database and exact staging search path before applying migrations.

The staging schema is seeded with one unit of Hosted capacity through existing operator controls. It never contains production owners, Paddle references, sessions, or allocations. A new Neon database or project is unnecessary for behavioral isolation and would require unavailable owner credentials or consume another free-tier project; sharing only the non-production database compute is acceptable for alpha staging.

### 3. Reuse the production provisioner protocol with database-isolated ownership

Staging points at the same authenticated provisioner endpoint but creates a distinct UUID-bound cell from its one-slot ledger. Existing provider names, tenant identity proofs, lifecycle idempotency, and deletion controls remain authoritative. The proof destroys the staging tenant after acceptance when the slot needs to be reclaimed.

Running a second cluster would test different infrastructure and add cost. Mocking the provisioner would fail to prove the path users actually depend on. Provider resource identifiers remain only in the isolated control-plane database and redacted operational output.

### 4. Make the Paddle catalog check a deployment gate

When `EXOMEM_PADDLE_PRICE_ID` is absent, the check reports that new checkout is disabled and exits successfully. When it is present, the check loads the explicit Exomem Paddle configuration, fetches the exact product and price from the selected Paddle environment, and requires:

- both resources are active;
- the price belongs to the configured product;
- `unit_price.currency_code` is `EUR`;
- `unit_price.amount` is `500`;
- `billing_cycle.interval` is `month` with frequency `1`.

It emits only environment, status, currency, amount, and interval facts—never credentials or provider identifiers. The same gate runs in Vercel before migrations/build and is available as an explicit operator command. This catches the observed €12 misconfiguration before another checkout can open.

### 5. Keep sandbox webhooks and scheduling explicit

Paddle Sandbox delivers to `https://staging.substratesystems.io/api/webhooks/paddle` with its own endpoint secret. During acceptance, the operator invokes the existing staging reconcile route using the staging scheduler secret until readiness; production scheduling is not redirected. Duplicate and stale webhook assertions use Paddle redelivery/simulation plus isolated database observations.

The proof then performs a real browser checkout with a Paddle Sandbox test card, opens the sandbox customer portal, and uses a staging ChatGPT connector for one capture/fresh-chat recall. It records counts and stable outcomes only.

## Risks / Trade-offs

- **A Preview inherits a production secret** → Staging uses branch-scoped variables and the database-name, search-path, branch, Paddle-environment, and catalog gates fail closed before migration or checkout.
- **The shared provisioner creates a cell that outlives a failed proof** → Capacity is one slot, identifiers stay in staging DB, and cleanup follows the normal owner deletion path before the next proof.
- **Paddle Sandbox and production event streams cross** → Separate API keys, client token, webhook endpoint secret, catalog IDs, public origin, and persisted provider environment make a cross-environment event fail closed.
- **Hobby compute is already near its monthly allowance** → Staging is invoked only for release proofs and has no always-on Vercel cron. Provider compute remains the one bounded cell.
- **A catalog API outage blocks deployment** → Existing production deployments keep serving; the new deployment fails rather than opening checkout under unverified pricing.
- **Sandbox proves behavior but not live merchant permissions** → Before inviting a paying friend, run the same read-only catalog gate against Live and inspect the checkout summary; do not complete a real purchase merely to test plumbing.

## Migration Plan

1. Merge code and operational docs with checkout still disabled in staging.
2. Create the isolated Postgres schema in the existing non-production verification database, apply migrations, and seed one staging capacity slot.
3. Create or reuse the Sandbox Exomem product and exact €5 monthly price, client token, API key, and webhook destination.
4. Configure branch-scoped Preview variables, create the `staging` branch, assign `staging.substratesystems.io`, and deploy.
5. Run the catalog/deployment preflight, then the full sandbox acceptance journey and cleanup.
6. Correct the production `EXOMEM_PADDLE_PRICE_ID`, run the Live catalog check, redeploy, and verify the read-only checkout summary is €5 before sending another invite.

Rollback removes `EXOMEM_PADDLE_PRICE_ID` from the staging branch first, which disables new checkout while preserving webhook, portal, reconciliation, and deletion handling. The staging domain or branch deployment can then be removed without touching production. Additive migrations remain in the isolated staging database.

## Open Questions

None. Moving staging to a separate Vercel project or self-hosted control plane can be reconsidered if Hobby limits become the bottleneck rather than application correctness.
