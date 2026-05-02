## 1. Migration Runner

- [ ] 1.1 Create `migrations/` directory at repo root.
- [ ] 1.2 Add `scripts/migrate.ts` that auto-creates `schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())` on first run, reads `migrations/*.sql` in filename order, and applies each unapplied file inside a single statement (or `BEGIN`/`COMMIT` for multi-statement files), recording the version on success.
- [ ] 1.3 Add npm script `"migrate": "tsx scripts/migrate.ts"` to `package.json`.
- [ ] 1.4 Verify locally against a Neon scratch branch: first run applies all migrations, second run is a no-op.

## 2. Schema

- [ ] 2.1 `migrations/0001_users.sql` — `CREATE EXTENSION IF NOT EXISTS citext;` plus `users` table (`id uuid pk default gen_random_uuid()`, `email citext unique not null`, `email_verified_at timestamptz`, `created_at timestamptz not null default now()`, `deleted_at timestamptz`).
- [ ] 2.2 `migrations/0002_auth_credentials.sql` — `auth_credentials` table (`user_id uuid pk references users(id) on delete cascade`, `server_password_hash text not null`, `client_salt bytea not null`, `kdf_params jsonb not null`, `wrapped_dek bytea not null`, `recovery_key_verifier text not null`, `recovery_key_wrapped_dek bytea not null`, `updated_at timestamptz not null default now()`). No `server_salt` column — argon2 PHC string already encodes the per-row salt.
- [ ] 2.3 `migrations/0003_refresh_tokens.sql` — `refresh_tokens` table (`id uuid pk default gen_random_uuid()`, `user_id uuid not null references users(id) on delete cascade`, `chain_id uuid not null`, `parent_id uuid references refresh_tokens(id)`, `token_hash bytea not null unique`, `issued_at timestamptz not null default now()`, `expires_at timestamptz not null`, `revoked_at timestamptz`). Index `(user_id, expires_at)` and `(chain_id)`.
- [ ] 2.4 `migrations/0004_signing_keys.sql` — `signing_keys` table (`kid text pk`, `public_key bytea not null`, `algorithm text not null default 'EdDSA'`, `created_at timestamptz not null default now()`, `retired_at timestamptz`).

## 3. Library

- [ ] 3.1 Add `argon2` to `dependencies` in `package.json`. Run install.
- [ ] 3.2 `src/lib/hosted-backup/db.ts` — Neon singleton mirroring `src/lib/license/db.ts`, plus typed query functions: `findUserByEmail`, `insertUser`, `getAuthCredentials`, `insertAuthCredentials`, `updateAuthCredentialsForRecovery`, `insertRefreshToken`, `findRefreshTokenByHash`, `revokeRefreshToken`, `revokeRefreshChain`, `getActiveSigningKeys`, `insertSigningKey`, `retireSigningKey`, `getSubscriptionStatus` (PR1 stub returning `'none'` with TODO referencing PR3).
- [ ] 3.3 `src/lib/hosted-backup/kdf.ts` — `validateKdfParams(p)` (rejects below-floor: memory < 65536, iter < 3, par < 4, algorithm ≠ `argon2id`); `hashServerPassword(value: Uint8Array)` and `verifyServerPassword(hash, value)` using `argon2.hash`/`argon2.verify` with `{ type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }`. Same helpers re-export for recovery verifier.
- [ ] 3.4 `src/lib/hosted-backup/jwt.ts` — `mintAccessToken({ userId, subscriptionStatus })` returning `{ token, jti, exp }`; `verifyAccessToken(token)` returning `{ userId, subscriptionStatus, jti }` or throwing `JwtError`. EdDSA over base64url(`header`)`.`base64url(`payload`)`, signed with `signBytes` from `src/lib/license/crypto.ts` style (using a separate keypair sourced from `ENDSTATE_JWT_PRIVATE_KEY_HEX`/`ENDSTATE_JWT_ACTIVE_KID`). Exp 900 s, `iss=process.env.ENDSTATE_OIDC_ISSUER_URL ?? 'https://substratesystems.io'`, `aud='endstate-backup'`, `nbf=iat`, `jti=randomUUID()`. Verify rejects wrong `aud`, wrong `iss`, expired (`exp<=now`), unknown `kid`, tampered signature, `nbf>now`.
- [ ] 3.5 `src/lib/hosted-backup/refresh.ts` — `issueRefreshToken({ userId, parentId?, chainId? })` returns `{ token, expiresAt }`; stores SHA-256(token); 30-day max chain lifetime. `rotateRefreshToken(presentedToken)` — if presented token is already revoked, revokes the entire chain and throws `RefreshReuseError`; otherwise revokes presented and issues a child token.
- [ ] 3.6 `src/lib/hosted-backup/auth-middleware.ts` — `requireAuth(req)` returns `{ userId, subscriptionStatus }` or throws `HostedBackupError(code='UNAUTHENTICATED', status=401)`; checks `Authorization: Bearer <jwt>`.
- [ ] 3.7 `src/lib/hosted-backup/api-version.ts` — `withApiVersion(response)` adds `X-Endstate-API-Version: 1.0` to a `NextResponse` and returns it. `SchemaVersion = '1.0'` constant exported from `types.ts`.
- [ ] 3.8 `src/lib/hosted-backup/types.ts` — request/response shapes for every endpoint in this PR plus shared types (`SubscriptionStatus = 'none' | 'active' | 'grace' | 'cancelled'`, `KdfParams`, `JwtClaims`).
- [ ] 3.9 `src/lib/hosted-backup/errors.ts` — `HostedBackupError(code, status, message, detail?)` extending Error; `errorResponse(err)` returns a `NextResponse` matching the contract §7 envelope `{ success: false, error: { code, message, detail?, remediation?, docsKey? } }` wrapped with `withApiVersion`.

## 4. Auth Routes

- [ ] 4.1 `src/app/api/auth/signup/route.ts` — `POST`, `runtime: 'nodejs'`. Validates email + base64 fields + KDF params against floor; in a single transaction inserts `users` row then `auth_credentials` row; mints access + refresh tokens; returns `{ userId, accessToken, refreshToken }`. On unique-email conflict returns `{ success: false, error: { code: 'EMAIL_TAKEN', ... } }` with status 409.
- [ ] 4.2 `src/app/api/auth/login/route.ts` — `POST`. If body has only `email`, returns `{ salt, kdfParams }` (always 200 even on unknown email — but only if a user exists; otherwise still 200 with shape but synthesised values) — see design §"Email enumeration trade-off". If body has `email + serverPassword`, verifies the hash and returns `{ userId, accessToken, refreshToken, wrappedDEK }`. Step 2 returns 401 `INVALID_CREDENTIALS` on hash mismatch.
- [ ] 4.3 `src/app/api/auth/refresh/route.ts` — `POST { refreshToken }` → `{ accessToken, refreshToken }`. On reuse detection (token already revoked), revokes the entire chain and returns 401 `REFRESH_REUSE_DETECTED`.
- [ ] 4.4 `src/app/api/auth/logout/route.ts` — `POST { refreshToken }` → `{ ok: true }`. Idempotent — already-revoked still returns `{ ok: true }`.
- [ ] 4.5 `src/app/api/auth/recover/route.ts` — `POST { email, recoveryKeyProof }`. Verifies argon2 against `recovery_key_verifier`. On success returns a short-lived recovery JWT (`aud='endstate-recover'`, exp=300 s) plus `recoveryKeyWrappedDEK`. On failure returns 401.
- [ ] 4.6 `src/app/api/auth/recover/finalize/route.ts` — `POST { recoveryToken, newServerPassword, newSalt, newKdfParams, newWrappedDEK }`. Verifies the recovery JWT, validates new KDF params against floor, atomically updates `auth_credentials` (server_password_hash + client_salt + kdf_params + wrapped_dek), revokes all existing refresh chains for the user, mints new access+refresh, returns `{ accessToken, refreshToken }`.

## 5. Account + OIDC Routes

- [ ] 5.1 `src/app/api/account/me/route.ts` — `GET`, auth-gated. Returns `{ userId, email, subscriptionStatus, createdAt }` wrapped with `withApiVersion`.
- [ ] 5.2 `src/app/api/.well-known/openid-configuration/route.ts` — `GET`. Returns OIDC discovery JSON with `endstate_extensions` block per contract §9. `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`.
- [ ] 5.3 `src/app/api/.well-known/jwks.json/route.ts` — `GET`. Reads `signing_keys` rows where `retired_at IS NULL OR retired_at > now() - interval '24 hours'`. Formats as JWKS (`{ keys: [{ kty: 'OKP', crv: 'Ed25519', x: <base64url>, kid, alg: 'EdDSA', use: 'sig' }] }`). `Cache-Control: public, s-maxage=300, stale-while-revalidate=60`.

## 6. Helper Scripts

- [ ] 6.1 `scripts/generate-jwt-keypair.ts` — generates Ed25519 keypair, prints `ENDSTATE_JWT_PRIVATE_KEY_HEX`, `ENDSTATE_JWT_ACTIVE_KID`, public-key hex. With `--commit`, INSERTs the public-key row into `signing_keys`. Documented in README.

## 7. Tests

Tests use `node:test` + `assert/strict`, matching `src/lib/license/__tests__/canonical-signing.test.ts`.

- [ ] 7.1 `src/lib/hosted-backup/__tests__/kdf.test.ts` — floor rejection (memory, iter, par, algorithm), hash+verify roundtrip.
- [ ] 7.2 `src/lib/hosted-backup/__tests__/jwt.test.ts` — mint+verify roundtrip; reject wrong audience, expired (`exp` in the past), wrong issuer, tampered signature, unknown kid, `nbf > now`.
- [ ] 7.3 `src/lib/hosted-backup/__tests__/refresh.test.ts` — fresh issuance + rotation; presenting an already-revoked token revokes the chain and refuses; chain lifetime cap.
- [ ] 7.4 `src/lib/hosted-backup/__tests__/oidc-discovery.test.ts` — discovery payload contains `issuer`, `jwks_uri`, `id_token_signing_alg_values_supported: ['EdDSA']`, and the full `endstate_extensions` block.
- [ ] 7.5 `src/lib/hosted-backup/__tests__/jwks.test.ts` — JWKS shape, base64url-encoded `x` field, only includes non-retired or recently-retired keys.

## 8. Docs

- [ ] 8.1 `README.md` — add a "Hosted Backup" section linking to `hosted-backup-contract.md`, documenting the four new env vars and the migration runner.
- [ ] 8.2 `.env.example` — add `ENDSTATE_OIDC_ISSUER_URL`, `ENDSTATE_JWT_PRIVATE_KEY_HEX`, `ENDSTATE_JWT_ACTIVE_KID` (DATABASE_URL already exists).

## 9. Verification

- [ ] 9.1 `npm run openspec:validate` passes strict.
- [ ] 9.2 `npm run build` succeeds (Next.js compiles, no type errors).
- [ ] 9.3 `node --test src/lib/hosted-backup/__tests__/*.test.ts` (via tsx) — all tests pass.
- [ ] 9.4 Local smoke: `npm run dev`; `curl -i http://localhost:3000/api/.well-known/openid-configuration` returns the expected JSON with `X-Endstate-API-Version: 1.0`; `curl -i http://localhost:3000/api/.well-known/jwks.json` returns a JWKS with at least one key.
- [ ] 9.5 Local smoke: signup → login (2-step) → refresh → call `/api/account/me` with the access token → 200 + `subscriptionStatus: 'none'`.

## 10. Release

- [ ] 10.1 Commit on `feat/hosted-backup-auth`: `feat(hosted-backup): add auth, JWT, OIDC discovery, migration runner`.
- [ ] 10.2 Hugo reviews diff before push.
- [ ] 10.3 Push; lefthook pre-push runs `openspec validate --all --strict` (must pass).
- [ ] 10.4 Open PR with title `feat(hosted-backup): add-hosted-backup-auth (PR1/3)` and body referencing this change folder.
- [ ] 10.5 Post-merge: deploy, run `npm run migrate` against the deployed Neon instance.
- [ ] 10.6 Archive: `npx openspec archive add-hosted-backup-auth`.
