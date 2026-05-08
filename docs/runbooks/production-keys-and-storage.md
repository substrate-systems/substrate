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

## Engine smoke test — operator-controlled subscription bypass

Substrate enforces an active Paddle subscription before accepting both write endpoints (`POST /api/backups`, `POST /api/backups/:id/versions`) and read endpoints (`GET /api/backups`, `GET /api/backups/:id/versions`, `POST /api/backups/:id/versions/:vid/download-urls`). To let the engine smoke test run end-to-end against production without provisioning a real subscription per disposable account, both `requireWriteAccess` and `requireReadAccess` check an opt-in regex pattern and exempt matching emails from the gate.

### How it works

- Env var: `HOSTED_BACKUP_TEST_EMAIL_PATTERN` — a `RegExp` source string. Empty / unset = bypass fully disabled (default).
- Implemented in `src/lib/hosted-backup/auth-middleware.ts`. The bypass applies symmetrically to **both reads and writes**.
- An invalid regex source fails closed: bypass disabled (one-time warning logged), service keeps running normally for real users.
- Each bypass-taken request emits `[hosted-backup] subscription gate bypassed for test account user=<id>` so usage is auditable.

### Why the bypass covers reads, not just writes

The smoke-test acceptance criterion is a complete round-trip: `signup → push → pull → byte-equal → delete`. The pull half (and any list-before-push the client may issue) hits read endpoints — `GET /api/backups`, `GET /api/backups/:id/versions`, `POST /api/backups/:id/versions/:vid/download-urls`. With the original write-only bypass, a fresh smoke account (`status="none"`) would get HTTP 200 on the push but HTTP 402 `SUBSCRIPTION_REQUIRED` the moment it tried to read anything back, so byte-equal verification could never run. Extending the bypass to reads is the only way to support the full smoke cycle for status-`none` accounts.

### Threat model

The bypass is safe because it is gated by **two** operator-controlled conditions, both of which must be true for any account to skip the gate:

1. **`HOSTED_BACKUP_TEST_EMAIL_PATTERN` is set in Vercel project settings.** Anyone with permission to set this already has full admin control of substrate (env vars, secrets, deploys, R2 credentials). The bypass cannot be enabled by an end user, by a backup client, or by a webhook.
2. **The user's stored email matches the regex at the time of the request.** The recommended pattern, `^smoketest\+\d+@example\.com$`, uses the [RFC 2606](https://datatracker.ietf.org/doc/html/rfc2606) reserved `example.com` domain, which no organic signup could match, plus the literal `smoketest+` prefix for additional defense-in-depth.

Worst case: an operator widens the regex to something permissive (e.g. `^.*$`) and effectively gives free hosted backup to every authenticated account until corrected. This blast radius is bounded by who can set the env var (only project admins) and is mitigated by the per-bypass `console.warn` audit log: every bypassed request logs the user id, so an unexpected spike is easy to spot in Vercel runtime logs.

Disable the bypass entirely by removing the env var and redeploying — see *Disable the bypass* below.

### Current production value

| Env var | Value | Environments |
|---------|-------|--------------|
| `HOSTED_BACKUP_TEST_EMAIL_PATTERN` | `^smoketest\+\d+@example\.com$` | Production, Preview, Development |

### ⚠️ Common pitfalls (env-var debugging)

Each of these has bitten us in production at least once during hosted-backup rollout. Walk all three before assuming a deeper bug.

**1. Env-var changes do not retroactively affect running deployments.** Vercel env vars only apply to deployments created **after** the variable is added or changed. The previous production deployment keeps the env it captured at build time. Setting or changing any env var requires a redeploy before functions see the new value. Vercel's GitHub integration auto-deploys on env-var change in many cases, but **don't rely on that** — always confirm a newer "Ready" production deploy exists before testing.
*(First seen: PR #4, `HOSTED_BACKUP_TEST_EMAIL_PATTERN` first install — smoke-test pushes kept hitting `SUBSCRIPTION_REQUIRED` until a fresh prod deploy was promoted.)*

**2. Env vars are scoped per environment (Production / Preview / Development) and do NOT propagate.** Setting in one scope does not set in others. Code that "works in Preview" may be entirely unconfigured in Production. Always run `vercel env ls` and verify the var is registered in **every** scope your test surface needs.
*(First seen: PR #5, scope diagnosis during the read-bypass extension.)*

**3. Env-var name must match what the code actually reads — `process.env.X` and `vercel env ls X` are two independent strings.** Project convention is `ENDSTATE_*` for hosted-backup secrets (`ENDSTATE_JWT_*`, `ENDSTATE_OIDC_*`, `ENDSTATE_R2_*`). Code that drifts from the convention — e.g. reads `R2_BUCKET` while ops sets `ENDSTATE_R2_BUCKET` — produces a 500 INTERNAL_ERROR with `Error: <NAME> is not set` the first time the code path runs in production. **Always grep the source for `process.env.<NAME>` and compare to `vercel env ls` before assuming an env var is wired up.** A missed reference is invisible until the unhappy path is exercised.
*(First seen: PR #6, R2 client constructor threw `Error: R2_BUCKET is not set` on the engine smoke test's first POST `/api/backups/:id/versions`. The endpoint had never run authenticated in production before — the bypass that lets a smoke account reach it only landed in PR #5.)*

### Verify the bypass is wired (substrate-side, no engine needed)

1. Confirm the env var is registered in every relevant environment:

   ```bash
   vercel env ls production | grep HOSTED_BACKUP_TEST_EMAIL_PATTERN
   vercel env ls preview    | grep HOSTED_BACKUP_TEST_EMAIL_PATTERN
   ```

   Both should show "Encrypted" with a `created` timestamp.

2. Confirm the active production deployment was created **after** that timestamp:

   ```bash
   vercel ls --prod | head -3
   ```

   Compare deploy "Age" against env-var "created". If the deploy is older, trigger a redeploy:

   ```bash
   vercel redeploy <latest-prod-deployment-url> --target=production
   ```

3. (One-shot diagnostic) If you suspect the runtime is reading a different value than expected (e.g., backslashes stripped by the dashboard UI), add a temporary module-load `console.log` in `src/lib/hosted-backup/auth-middleware.ts`, push to a branch (Vercel will auto-build a Preview), then read the runtime log:

   ```bash
   vercel logs https://<preview-url> -x --no-follow --since 30m \
     | grep HOSTED_BACKUP_TEST_EMAIL_PATTERN
   ```

   Expected JSON shape:
   ```json
   {"set":true,"isEmpty":false,"length":29,
    "value":"^smoketest\\+\\d+@example\\.com$",
    "compiles":true,"compileError":null,"matchesSample":true}
   ```

   `length:29`, `compiles:true`, `matchesSample:true` is the green-light state. Remove the diagnostic log immediately after.

4. (End-to-end) Run the production round-trip from the substrate side without involving the engine. Provision a fresh smoke account, exercise the bypass on both gates, **and** the R2 presign path that the engine push depends on, then clean up:

   ```bash
   node --input-type=module <<'EOF'
   import { randomBytes, createHash } from 'node:crypto';
   const BASE = 'https://substratesystems.io';
   const email = `smoketest+${Math.floor(Date.now()/1000)}@example.com`;
   const b64 = (n) => randomBytes(n).toString('base64');
   const hex = (buf) => Buffer.from(buf).toString('hex');
   const signup = await (await fetch(`${BASE}/api/auth/signup`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({
       email,
       serverPassword: b64(32),
       salt: b64(16),
       kdfParams: { algorithm: 'argon2id', memory: 65536, iterations: 3, parallelism: 4 },
       wrappedDEK: b64(64),
       recoveryKeyVerifier: b64(32),
       recoveryKeyWrappedDEK: b64(64),
     }),
   })).json();
   const auth = { authorization: `Bearer ${signup.accessToken}` };
   const write = await fetch(`${BASE}/api/backups`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ name: 'verify' }) });
   const { backupId } = await write.json();
   const read  = await fetch(`${BASE}/api/backups`, { headers: auth });
   // Exercise R2 presign path. Body must satisfy the contract §7 schema.
   const chunkBytes = randomBytes(64);
   const versions = await fetch(`${BASE}/api/backups/${backupId}/versions`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json', ...auth },
     body: JSON.stringify({
       encryptedManifest: b64(128),
       chunkMetadata: [{ index: 0, encryptedSize: chunkBytes.length, sha256: hex(createHash('sha256').update(chunkBytes).digest()) }],
     }),
   });
   const versionsBody = await versions.json();
   await fetch(`${BASE}/api/account`, { method: 'DELETE', headers: auth });
   console.log({
     email,
     write: write.status,
     read: read.status,
     versions: versions.status,
     hasUploadUrls: Array.isArray(versionsBody.uploadUrls) && versionsBody.uploadUrls.length > 0,
   });
   EOF
   ```

   Green-light state: `{ write: 200, read: 200, versions: 200, hasUploadUrls: true }`. The `versions: 200` step exercises the R2 client construction, presign signing, and quota check end-to-end — i.e. catches both bypass and R2 env-var regressions in one round-trip. A 500 on the `versions` step almost always means an R2 env var is missing, mis-prefixed, or scoped only to Preview (see *Common pitfalls* above); check Vercel logs for `Error: ENDSTATE_R2_<NAME> is not set`. Confirm in production runtime logs that **three** `[hosted-backup] subscription gate bypassed` lines appeared for the userId returned by signup (one per gated endpoint: write, read, versions).

### Disable the bypass (e.g., to re-validate the paywall)

Remove the env var (or set it to empty) and redeploy:

```bash
vercel env rm HOSTED_BACKUP_TEST_EMAIL_PATTERN production
vercel env rm HOSTED_BACKUP_TEST_EMAIL_PATTERN preview
vercel env rm HOSTED_BACKUP_TEST_EMAIL_PATTERN development
vercel redeploy <latest-prod-deployment-url> --target=production
```

After redeploy, every user — including `smoketest+...@example.com` accounts — falls back to the standard subscription gate on both reads and writes.

---

## Reference

- Schema: `migrations/0004_signing_keys.sql`
- JWT minting/verification: `src/lib/hosted-backup/jwt.ts`
- R2 client setup: `src/lib/hosted-backup/r2.ts`
- Auth middleware (subscription gate + bypass): `src/lib/hosted-backup/auth-middleware.ts`
- Contract: `docs/hosted-backup-contract.md` §4 (JWT), §8 (R2), §10 (subscription gating)
- OpenSpec changes for the bypass: `openspec/changes/add-hosted-backup-test-bypass/` (initial, write-only) and `openspec/changes/extend-hosted-backup-test-bypass-to-reads/` (extends to reads)
