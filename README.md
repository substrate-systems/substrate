# Substrate

Public homepage for Substrate — a foundational systems company.

## Development

```bash
npm install
npm run dev
```

### Windows Development

On Windows, `npm run dev` automatically handles stale lock files and process cleanup. The dev server will:

- Detect and kill any existing Next.js dev processes for this repo
- Remove stale `.next/dev/lock` files
- Start cleanly on port 3000 every time

This prevents "unable to acquire lock" errors and port hopping after crashes or forced terminal closes.

## Build

```bash
npm run build
npm start
```

## Stack

- Next.js 16 (App Router)
- TypeScript
- Tailwind CSS v4

## Hosted Backup

The substrate also serves as the auth issuer + metadata store + presigned-URL minter for **Endstate Hosted Backup v2**. Protocol locked in [`hosted-backup-contract.md`](./hosted-backup-contract.md) (OIDC discovery, EdDSA JWTs, Argon2id-derived `serverPassword + masterKey` split, R2 storage with 5-version retention).

**Migrations.**

```bash
npm run migrate         # apply pending migrations from migrations/*.sql
npm run migrate:dry     # list pending migrations without applying
```

The runner auto-creates a `schema_migrations` tracking table on first invocation.

**JWT signing key.** Generate the active EdDSA keypair (and optionally insert the public-key row into `signing_keys`):

```bash
tsx scripts/generate-jwt-keypair.ts            # print env vars only
tsx scripts/generate-jwt-keypair.ts --commit   # also INSERT the public key row
```

Then set `ENDSTATE_JWT_PRIVATE_KEY_HEX` and `ENDSTATE_JWT_ACTIVE_KID` in your environment.

**Env vars (Hosted Backup-specific).**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string |
| `ENDSTATE_OIDC_ISSUER_URL` | OIDC issuer URL (`iss` claim, JWKS URL prefix). Defaults to `https://substratesystems.io`. |
| `ENDSTATE_JWT_PRIVATE_KEY_HEX` | 32-byte seed (hex) for the active JWT signing key |
| `ENDSTATE_JWT_ACTIVE_KID` | `kid` for the active signing key (matches a row in `signing_keys`) |

**R2 (object storage).** Hosted Backup uses Cloudflare R2 for encrypted blob storage. Create a bucket; mint an R2 token scoped to that bucket; set:

| Variable | Purpose |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | R2 token's access key |
| `R2_SECRET_ACCESS_KEY` | R2 token's secret |
| `R2_BUCKET` | Bucket name (e.g. `endstate-backups`) |
| `R2_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `HOSTED_BACKUP_QUOTA_BYTES` | Optional override of the 1 GiB per-user quota |

The server only mints presigned PUT/GET URLs (5-minute TTL); chunks transit directly between client and R2.

**Paddle webhook.** Hosted Backup adds a second webhook receiver at `/api/webhooks/paddle` for subscription events. It reuses the existing `PADDLE_WEBHOOK_SECRET` and `PADDLE_API_KEY`. Configure Paddle to deliver subscription events to this URL in addition to the existing license webhook.

See the configured env vars in your hosting environment for the full list.
