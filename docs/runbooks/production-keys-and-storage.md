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

**4. Asymmetric handling between paired endpoints.** When two endpoints implement opposite halves of the same protocol contract (upload mints URL → download fetches URL; encrypt → decrypt; write → read), an invariant on one side has to be honored on the other. Drift is invisible in unit tests that exercise each half in isolation. The hosted-backup contract uses `chunkIndex = -1` as the sentinel for the manifest blob in **both** the upload-URL response (`POST /api/backups/:id/versions`) and the download-URL request (`POST /api/backups/:id/versions/:vid/download-urls`); the upload side was correct from PR #2, but the download side validated all requested indices against the chunks table — where `-1` is by definition absent — and threw `NOT_FOUND` before ever reaching the manifest case. **When you find a sentinel value or magic-number convention in code, grep the codebase for every other place that value could appear and verify the symmetry.** Add an end-to-end test that round-trips through both endpoints with the sentinel.
*(First seen: PR #7, `POST .../download-urls` with `chunkIndices: [-1]` returned `NOT_FOUND`, blocking the engine smoke test's pull half on a real prod backup `9e6f8cc9-…`/`910f3c00-…`. Push had worked because that path mints the manifest URL itself; download couldn't fetch what push had written.)*

**5. Migrations auto-run on Vercel *production* deploys via `vercel-build`** (since 2026-05-27). `package.json`'s `vercel-build` script chains `scripts/vercel-maybe-migrate.ts` before `next build`. The migrate step checks `VERCEL_ENV` and only runs against the production database when `VERCEL_ENV === 'production'` — preview and development builds skip it. A failing migration aborts the build and the previous deploy stays live.

**Implications:**

- **Adding a migration: just merge.** When you add `migrations/00XX_*.sql` and a PR that depends on the schema in the same merge, the Vercel deploy of `main` applies the migration before serving traffic. No manual step needed for the happy path.
- **Manual override:** set `SKIP_VERCEL_MIGRATE=1` in Vercel project env to disable temporarily (e.g. during incident response where a migration is hot-failing and you need the previous code path back up faster than a revert). Unset it once recovered.
- **Manual application is still possible** for one-off backfills or pre-merge dry-runs:

  ```bash
  vercel env pull .env.production.local --environment=production
  npx tsx --env-file=.env.production.local scripts/migrate.ts --dry  # confirm pending
  npx tsx --env-file=.env.production.local scripts/migrate.ts        # apply
  rm .env.production.local                                            # wipe local credentials
  ```

- **Preview deploys** still skip migrations entirely. If you need to test a migration's effect on a preview env, point that preview's `DATABASE_URL` at a separate Neon branch and apply via the manual `tsx --env-file=...` form above.
*(First seen: v2.0.0 cutover, migration `0011_recovery_tokens_used.sql` was caught pre-merge by manual review during the substrate→engine handoff. Repeated 2026-05-27 with `0015_account_sessions.sql` — engine v2.4.0 and gui-v2.7.0 / v2.8.0 all shipped before the migration was applied, and the new `/account/start` route 500'd at production until the manual migration ran. That incident motivated wiring the auto-migration into `vercel-build`.)*

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

4. (End-to-end) Run a full round-trip against production from the substrate side, without involving the engine. **The recipe below MUST exercise every endpoint the engine smoke test touches** — adding a new endpoint to the engine flow without adding it here is how regressions slip through. Update this script before extending the engine flow.

   The engine smoke test surface is exactly these endpoints:

   | Endpoint                                                                       | Auth                | Why it's in the recipe                                                  |
   |--------------------------------------------------------------------------------|---------------------|-------------------------------------------------------------------------|
   | `POST /api/auth/signup`                                                        | none                | provision a fresh smoke account                                          |
   | `POST /api/backups`                                                            | `requireWriteAccess`| create backup; bypass on writes                                          |
   | `GET /api/backups`                                                             | `requireReadAccess` | list backups; bypass on reads                                            |
   | `POST /api/backups/{id}/versions`                                              | `requireWriteAccess`| create version + R2 upload-URL mint (incl. manifest URL with `-1`)       |
   | `POST /api/backups/{id}/versions/{vid}/download-urls` with `[-1]`              | `requireReadAccess` | manifest-only download; sentinel handling                                |
   | `POST /api/backups/{id}/versions/{vid}/download-urls` with `[-1, 0]`           | `requireReadAccess` | mixed manifest + chunk download; symmetry with upload                    |
   | `GET /api/backups/{id}/versions`                                               | `requireReadAccess` | list versions for pull                                                   |
   | `DELETE /api/account`                                                          | `requireAuth`       | smoke-account cleanup                                                    |

   Recipe:

   ```bash
   node --input-type=module <<'EOF'
   import { randomBytes, createHash } from 'node:crypto';
   const BASE = 'https://substratesystems.io';
   const email = `smoketest+${Math.floor(Date.now()/1000)}@example.com`;
   const b64 = (n) => randomBytes(n).toString('base64');
   const hex = (buf) => Buffer.from(buf).toString('hex');
   const status = async (label, p) => { const r = await p; return [label, r.status, await r.text()]; };

   const out = {};

   // 1. signup
   const signupRes = await fetch(`${BASE}/api/auth/signup`, {
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
   });
   const signup = await signupRes.json();
   out.signup = signupRes.status;
   const auth = { authorization: `Bearer ${signup.accessToken}` };

   // 2. POST /api/backups (write — bypass)
   const writeRes = await fetch(`${BASE}/api/backups`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ name: 'verify' }) });
   const { backupId } = await writeRes.json();
   out.write = writeRes.status;

   // 3. GET /api/backups (read — bypass)
   const readRes = await fetch(`${BASE}/api/backups`, { headers: auth });
   out.read = readRes.status;

   // 4. POST /api/backups/{id}/versions (write — bypass + R2 upload presign incl. manifest with chunkIndex=-1)
   const chunkBytes = randomBytes(64);
   const versionsRes = await fetch(`${BASE}/api/backups/${backupId}/versions`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json', ...auth },
     body: JSON.stringify({
       encryptedManifest: b64(128),
       chunkMetadata: [{ index: 0, encryptedSize: chunkBytes.length, sha256: hex(createHash('sha256').update(chunkBytes).digest()) }],
     }),
   });
   const versionsBody = await versionsRes.json();
   out.versions = versionsRes.status;
   out.versions_uploadUrlIndices = (versionsBody.uploadUrls ?? []).map(u => u.chunkIndex);
   const versionId = versionsBody.versionId;

   // 5. POST .../download-urls with [-1] (manifest only)
   const dlManifestRes = await fetch(`${BASE}/api/backups/${backupId}/versions/${versionId}/download-urls`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json', ...auth },
     body: JSON.stringify({ chunkIndices: [-1] }),
   });
   const dlManifest = await dlManifestRes.json();
   out.dlManifest = dlManifestRes.status;
   out.dlManifest_indices = (dlManifest.urls ?? []).map(u => u.chunkIndex);

   // 6. POST .../download-urls with [-1, 0] (manifest + chunk)
   const dlMixedRes = await fetch(`${BASE}/api/backups/${backupId}/versions/${versionId}/download-urls`, {
     method: 'POST',
     headers: { 'Content-Type': 'application/json', ...auth },
     body: JSON.stringify({ chunkIndices: [-1, 0] }),
   });
   const dlMixed = await dlMixedRes.json();
   out.dlMixed = dlMixedRes.status;
   out.dlMixed_indices = (dlMixed.urls ?? []).map(u => u.chunkIndex);

   // 7. GET /api/backups/{id}/versions (list versions)
   const listVersionsRes = await fetch(`${BASE}/api/backups/${backupId}/versions`, { headers: auth });
   const listVersions = await listVersionsRes.json();
   out.listVersions = listVersionsRes.status;
   out.listVersions_count = (listVersions.versions ?? []).length;

   // 8. DELETE /api/account (cleanup)
   const delRes = await fetch(`${BASE}/api/account`, { method: 'DELETE', headers: auth });
   out.cleanup = delRes.status;

   console.log(JSON.stringify({ email, userId: signup.userId, ...out }, null, 2));
   EOF
   ```

   **Green-light state — every line must match exactly:**

   ```json
   {
     "signup": 200,
     "write": 200,
     "read": 200,
     "versions": 200,
     "versions_uploadUrlIndices": [-1, 0],
     "dlManifest": 200,
     "dlManifest_indices": [-1],
     "dlMixed": 200,
     "dlMixed_indices": [-1, 0],
     "listVersions": 200,
     "listVersions_count": 1,
     "cleanup": 200
   }
   ```

   Anything else means the engine smoke test will fail at that step. Common interpretations:
   - any `402` → bypass not firing; walk pitfalls 1–3.
   - `500` on `versions` → R2 env var missing or mis-prefixed (pitfall 3); check Vercel logs for `Error: ENDSTATE_R2_<NAME> is not set`.
   - `404` on `dlManifest` (with `[-1]`) → manifest-sentinel handling drift between upload and download paths; this is pitfall 4.
   - Missing `-1` in `versions_uploadUrlIndices` → upload path no longer emits the manifest URL; engine push will succeed for chunks but never upload the manifest blob, so pull will 404.

   Confirm in production runtime logs that **six** `[hosted-backup] subscription gate bypassed for test account user=<id>` lines appear for the userId returned by signup. The recipe makes six gated calls (`POST /api/backups`, `GET /api/backups`, `POST .../versions`, `POST .../download-urls` ×2, `GET .../versions`); the bypass fires once per gated call. `DELETE /api/account` is `requireAuth`-only (no subscription gate, no audit log).

   **Do not signal green-light to the engine team unless the JSON above matches exactly and the audit log lines are present.**

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

## CRON_SECRET — scheduled cron authentication

Vercel invokes the crons declared in `vercel.json` (`/api/cron/claim-followups`
daily 12:00 UTC, `/api/cron/backup-gc` daily 03:17 UTC) with
`Authorization: Bearer <CRON_SECRET>`. Both routes fail closed: when the env
var is unset, **every** invocation is rejected with 401 — including Vercel's
own scheduled ones — so the crons silently do nothing until the secret is
installed.

### 1. Generate

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 2. Install

Vercel dashboard → project → Settings → Environment Variables → Production:

- `CRON_SECRET` → the generated value

Redeploy (env vars apply on the next deployment).

### 3. Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://substratesystems.io/api/cron/backup-gc
```

Expected `401`. Then with the secret:

```bash
curl -s -H "Authorization: Bearer <CRON_SECRET>" https://substratesystems.io/api/cron/backup-gc
```

Expected `200` with per-pass GC counts. Scheduled runs appear under the
project's Cron Jobs tab in the Vercel dashboard.

### Rotation

Generate a new value, overwrite the env var, redeploy. There is no grace
window to manage — the next scheduled invocation simply uses the new secret.

---

## Reference

- Schema: `migrations/0004_signing_keys.sql`
- JWT minting/verification: `src/lib/hosted-backup/jwt.ts`
- R2 client setup: `src/lib/hosted-backup/r2.ts`
- Auth middleware (subscription gate + bypass): `src/lib/hosted-backup/auth-middleware.ts`
- Contract: `docs/hosted-backup-contract.md` §4 (JWT), §8 (R2), §10 (subscription gating)
- OpenSpec changes for the bypass: `openspec/changes/add-hosted-backup-test-bypass/` (initial, write-only) and `openspec/changes/extend-hosted-backup-test-bypass-to-reads/` (extends to reads)
