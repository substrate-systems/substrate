## Why

Endstate Hosted Backup v2 (the optional paid tier where users upload encrypted profile backups to Endstate-operated infrastructure) needs an auth backend on substrate. The contract — `hosted-backup-contract.md` at the repo root — is locked: zero-knowledge end-to-end encryption, Argon2id-derived `serverPassword + masterKey` split, EdDSA JWTs, OIDC discovery so self-hosters can swap the backend out. The substrate currently has no users, no JWTs, no migration system. This change builds the foundation that PR2 (storage) and PR3 (subscriptions) layer on top of.

## What Changes

- New `src/lib/hosted-backup/` module: typed Postgres queries, Argon2id helpers, EdDSA JWT mint/verify, opaque refresh-token rotation with reuse-detection, auth middleware, error envelope, `X-Endstate-API-Version: 1.0` response wrapper.
- New auth endpoints: `POST /api/auth/{signup,login,refresh,logout,recover,recover/finalize}`. Login is two-step per contract §5; recovery is two-step per contract §6.
- New account endpoint: `GET /api/account/me`.
- New OIDC discovery endpoints: `GET /api/.well-known/{openid-configuration,jwks.json}`. The `endstate_extensions` block lets the engine bootstrap from a single `ENDSTATE_OIDC_ISSUER_URL`.
- New migration system: `migrations/*.sql` ordered numerically + `scripts/migrate.ts` runner that auto-creates a `schema_migrations` tracking table on first invocation. Mirrors no ORM — keeps parity with the existing raw-SQL pattern.
- New tables (PR1 only): `users`, `auth_credentials`, `refresh_tokens`, `signing_keys`. Contract §13's KDF-floor and JWT-shape locks are enforced server-side.
- New env vars: `ENDSTATE_OIDC_ISSUER_URL`, `ENDSTATE_JWT_PRIVATE_KEY_HEX`, `ENDSTATE_JWT_ACTIVE_KID`. Documented in `.env.example`.
- New helper script: `scripts/generate-jwt-keypair.ts` (Ed25519 keypair generation + optional `signing_keys` row insert).
- README gets a "Hosted Backup" section pointing at the contract.

## Capabilities

### New Capabilities

- `hosted-backup-auth`: Signup, two-step login, refresh rotation with reuse-detection, logout, two-step recovery, JWT issuance and validation, KDF floor enforcement, OIDC discovery, JWKS publication, and the `X-Endstate-API-Version` response header.
- `hosted-backup-account`: `GET /api/account/me` returning the authenticated user's profile and subscription status.

### Modified Capabilities

<!-- None — no existing specs cover hosted-backup auth or accounts. -->

## Impact

- New directory `src/lib/hosted-backup/` (eight files + tests).
- New routes under `src/app/api/auth/`, `src/app/api/account/`, `src/app/api/.well-known/`.
- New top-level `migrations/` directory and `scripts/migrate.ts`, `scripts/generate-jwt-keypair.ts`.
- Database schema additions: `users`, `auth_credentials`, `refresh_tokens`, `signing_keys`, plus the runner-managed `schema_migrations`.
- New runtime dependency: `argon2`.
- New env vars: `ENDSTATE_OIDC_ISSUER_URL`, `ENDSTATE_JWT_PRIVATE_KEY_HEX`, `ENDSTATE_JWT_ACTIVE_KID`.
- README gets a "Hosted Backup" section.
- No changes to existing license routes, license libs, or any pre-existing capability.
