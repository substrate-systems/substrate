# Production Keys & Storage — Runbook

## Current state

| Item | Value | Installed |
|------|-------|-----------|
| JWT signing kid | `endstate-prod-2026-05` | 2026-05-03 |
| R2 bucket | `endstate-backups-prod` | 2026-05-03 |
| R2 region | EU (Cloudflare) | 2026-05-03 |

---

## JWT signing key — generate and install a new key

Use this procedure when rotating the JWT signing key (e.g. suspected compromise, annual rotation).

### 1. Generate

Edit `scripts/generate-jwt-keypair.ts` line:
```typescript
const kid = `hb-${randomUUID()}`;
```
Change to a new date-based kid, e.g.:
```typescript
const kid = 'endstate-prod-2026-11';
```

Run:
```bash
npx tsx scripts/generate-jwt-keypair.ts
```

Keep the terminal open. **Do not save output to a file.**

Revert the script edit after running.

### 2. Insert public key into Neon

```bash
DATABASE_URL='<prod-neon-url>' psql -c \
  "INSERT INTO signing_keys (kid, public_key, algorithm) VALUES ('<kid>', '\\x<pubhex>', 'EdDSA');"
```

Or via Neon dashboard SQL editor:
```sql
INSERT INTO signing_keys (kid, public_key, algorithm)
VALUES ('<kid>', '\x<pubhex>', 'EdDSA');
```

### 3. Set Vercel env vars

Vercel dashboard → project → Settings → Environment Variables → Production:

- `ENDSTATE_JWT_PRIVATE_KEY_HEX` → new private key hex
- `ENDSTATE_JWT_ACTIVE_KID` → new kid

### 4. Retire the old key

After deploying with the new kid, retire the old one (24h grace window keeps in-flight tokens valid):

```sql
UPDATE signing_keys SET retired_at = now() WHERE kid = '<old-kid>';
```

The old key remains in JWKS for 24 hours, then drops off automatically.

### 5. Redeploy and verify

```bash
curl https://substratesystems.io/api/.well-known/jwks.json
```

Expected: two keys briefly (old retired + new active), then one key after 24h.

---

## R2 credentials — rotate

Use this procedure when rotating the Cloudflare R2 API token.

### 1. Create a new API token

Cloudflare dashboard → R2 → Manage R2 API Tokens → Create API token:
- Permissions: Object Read & Write
- Scope: `endstate-backups-prod` bucket only
- TTL: no expiry

Capture the new Access Key ID and Secret Access Key.

### 2. Update Vercel env vars

Vercel dashboard → Settings → Environment Variables → Production:

- `ENDSTATE_R2_ACCESS_KEY_ID` → new access key id
- `ENDSTATE_R2_SECRET_ACCESS_KEY` → new secret (mark as Sensitive)

### 3. Redeploy

Trigger a Vercel production redeploy to pick up the new credentials.

### 4. Verify

Add the new secret temporarily to `.env.production.local`, then:

```bash
set -a && source .env.production.local && set +a && npx tsx -e "
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
const c = new S3Client({
  region: 'auto',
  endpoint: process.env.ENDSTATE_R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.ENDSTATE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.ENDSTATE_R2_SECRET_ACCESS_KEY
  }
});
c.send(new ListObjectsV2Command({ Bucket: process.env.ENDSTATE_R2_BUCKET }))
  .then(r => console.log('OK — bucket reachable, object count:', r.KeyCount))
  .catch(console.error);
"
```

Then re-pull from Vercel to clear the secret from disk:
```bash
vercel env pull .env.production.local --environment=production
```

### 5. Revoke old token

Cloudflare dashboard → R2 → Manage R2 API Tokens → delete the old token.

---

## Reference

- Schema: `migrations/0004_signing_keys.sql`
- JWT minting/verification: `src/lib/hosted-backup/jwt.ts`
- R2 client setup: `src/lib/hosted-backup/r2.ts`
- Contract: `docs/hosted-backup-contract.md` §4 (JWT), §8 (R2)
