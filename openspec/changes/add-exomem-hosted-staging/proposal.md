## Why

The paid Hosted path can only be exercised safely today through disposable previews or a real production charge. The private alpha needs one repeatable staging surface that proves the exact €5 Paddle Sandbox journey, migrations, provisioning, and memory round trip without touching production data or taking money.

## What Changes

- Add a permanent `staging` deployment contract for the existing Vercel project, bound to `staging.substratesystems.io` and isolated from production by database and Paddle environment.
- Fail a paid-enabled deployment before checkout when the configured Paddle product or price is not active, monthly, EUR, exactly €5, and mutually linked in the selected environment.
- Make staging migrations explicit and branch-bound instead of relying on the production-only Vercel migration hook.
- Add a redacted operator workflow for configuring and proving invitation, sandbox payment, exactly-once provisioning, capture/recall, and customer portal access.
- Keep public self-serve closed and keep the production catalog, database, webhook, and customer records outside the staging path.

## Capabilities

### New Capabilities

- `exomem-hosted-staging`: A permanent, isolated Hosted staging environment and its safe deployment and acceptance contract.

### Modified Capabilities

- `exomem-hosted-entitlements`: Paid checkout is deployable only after the selected Paddle catalog has been verified as the intended active €5 monthly item.

## Impact

This affects the Vercel build/migration gate, Exomem Paddle configuration validation, deployment scripts and tests, and the Hosted alpha runbook. Operational setup touches one existing Vercel project, one branch-bound staging domain, an isolated schema in the existing non-production Postgres database, Paddle Sandbox catalog and webhook resources, and one bounded provider cell; it does not add a Vercel project or change production billing data.
