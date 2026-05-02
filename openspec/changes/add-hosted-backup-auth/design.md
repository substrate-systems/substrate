## Context

The substrate currently issues offline-verifiable license keys (`/api/license/*`) but has no concept of users, sessions, or JWTs. Hosted Backup v2 introduces a paid tier where the client uploads encrypted blobs to Endstate-operated infrastructure. The cryptographic split — `Argon2id(passphrase, salt) → 64 bytes`, where the first 32 bytes (`serverPassword`) reach the server and the second 32 bytes (`masterKey`) never leave the device — means the server authenticates without ever seeing material that could decrypt user data. This is a structural property of the protocol, not a policy.

The full protocol is locked in `hosted-backup-contract.md` at the repo root. This change implements the auth foundation only: users, credentials, refresh tokens, signing keys, plus the JWT/JWKS/OIDC plumbing the engine and a future GUI need to bootstrap.

PR2 (storage) and PR3 (subscriptions) extend the same module. The `subscription_status` JWT claim is wired in PR1 against a stub helper that returns `'none'`; PR3 swaps in the real `subscriptions`-table lookup.

## Goals / Non-Goals

**Goals:**

- Implement the full auth surface from contract §5 (signup, two-step login, refresh, logout) and §6 (recover, recover/finalize).
- Issue EdDSA JWTs whose claims and lifetime exactly match contract §4.
- Publish OIDC discovery + JWKS so a self-hoster can swap in any compliant issuer; expose the `endstate_extensions` block per contract §9.
- Enforce the Argon2id parameter floor (contract §2) on every signup and recovery-finalize.
- Establish a versioned migration system (`migrations/` + `scripts/migrate.ts`) without introducing an ORM.
- Detect refresh-token reuse and revoke entire chains (contract §5: 30-day max chain lifetime).

**Non-Goals:**

- R2, presigned URLs, backup metadata — that is PR2.
- Paddle webhook, subscription state machine, GDPR account deletion — that is PR3.
- Real subscription lookup — PR1 stubs the helper to `'none'`.
- Email verification (contract is silent; deferred to v1.x per the prompt).
- Email notifications for any auth event (deferred to v1.x).
- Edge rate limiting (deferred to edge-config; the contract assumes it but does not specify it).

## Decisions

**Server-side password hash uses argon2id at low cost, not bcrypt.**
The input to the server hash is already 32 bytes of high-entropy KDF output, so the hash's anti-brute-force role is minor. Using `argon2id` keeps a single algorithm story across client KDF, server `serverPassword` hash, and the recovery-key verifier. Cost params are reduced to `{ memoryCost: 19456, timeCost: 2, parallelism: 1 }` (~19 MiB) since the input is already strong; full client cost on the server would waste CPU. Alternative considered: bcrypt cost 12. Rejected because it introduces a second algorithm where one is sufficient.

**JWT signing keys: private key in env, `signing_keys` table holds public keys only.**
This mirrors the existing `src/lib/license/crypto.ts` pattern (private key from `ENDSTATE_LICENSE_PRIVATE_KEY`). The `signing_keys` table is read-only for runtime — it serves JWKS and identifies historical kids for verifying still-valid (≤15 min old) tokens after a rotation. Active private key is loaded from `ENDSTATE_JWT_PRIVATE_KEY_HEX` with `kid=ENDSTATE_JWT_ACTIVE_KID`. Rotation is a manual env-update + table-row insert via `scripts/generate-jwt-keypair.ts`. Auto-rotation is explicitly out of v1 per the prompt. Alternative considered: AES-GCM-wrap the private key in the DB. Rejected because v1 is single-tenant; Neon is encrypted at rest; the env-loaded approach is the existing pattern Hugo already trusts.

**Refresh tokens: opaque, SHA-256-hashed, with chain-id reuse detection.**
Each refresh token is 32 random bytes, base64url-encoded for transport. Server stores `SHA-256(token)` as `bytea`. Each refresh chain has a UUID `chain_id`; rotating the token issues a child whose `parent_id` points at the presented row. If a presented token is already revoked, the entire chain is revoked and the response is 401 — this is the canonical pattern for detecting that an attacker has captured and is using a refresh token in parallel with the legitimate user. Max chain lifetime is 30 days (contract §5).

**Migrations: SQL files + tracking table, runner-managed.**
The repo has no ORM and the prompt forbids introducing one. `scripts/migrate.ts` reads `migrations/*.sql` ordered by filename, checks `schema_migrations`, and applies each unapplied file. The tracking table is created by the runner on first invocation, not by a migration file (avoids the chicken-and-egg of the schema migration that creates the schema-migrations table). Idempotent across runs.

**`citext` for the email column.**
Per Postgres docs the canonical case-insensitive equality pattern. Avoids hand-written `LOWER(email) = LOWER($1)` everywhere. The migration runs `CREATE EXTENSION IF NOT EXISTS citext;` once. Neon supports `citext`.

**Two-step login leaks email existence — accept it, document it.**
Step 1 returns the user's `salt` and `kdfParams` so the client can derive the same `serverPassword` it derived at signup. This necessarily reveals "this email is registered" to anyone hitting the endpoint. The contract calls this out as an accepted trade-off (matches Bitwarden, Filen, Standard Notes). Mitigation: edge rate-limiting, deferred. We do **not** synthesise a fake response for unknown emails — the salt would necessarily differ from any real future signup, and the deception is detectable. Honest 404 on unknown email; rely on rate-limiting for the abuse case.

**Email enumeration trade-off (login step 1 specifically).**
The contract does not specify the response shape for unknown email at step 1. We return `{ success: false, error: { code: 'EMAIL_NOT_FOUND' } }` with status 404. This is the simplest implementation; a future iteration could synthesise a deterministic salt from `HMAC(server_secret, email)` to make existence-probing return-shape-equivalent, but doing so introduces a second entropy source for salts and complicates recovery. Defer.

**JWT verification accepts recently-retired kids for 24 hours.**
Active access-token lifetime is 15 minutes, but client clocks may skew and tokens may sit in queues. A 24-hour grace on retired kids ensures rotation never invalidates in-flight tokens. JWKS endpoint serves the same set so out-of-process verifiers (e.g., the engine) see consistent state.

**Recovery finalize revokes all existing refresh chains.**
A user invoking recovery has implicitly lost trust in any device that had access. Forcing re-login on every other device is the safe default. Documented in the contract §6 indirectly ("user is prompted to set a new passphrase, …").

## Risks / Trade-offs

- **[Risk] argon2 native binding fails on Vercel runtime** → Mitigation: `argon2` is a Node native module; works on Vercel's `nodejs` runtime (we already depend on `node:crypto` in the license routes which is fine). All hosted-backup routes set `runtime: 'nodejs'` explicitly. Verified at build time.
- **[Risk] Cold-start latency on Vercel due to Neon connection** → Mitigation: same lazy singleton pattern as `src/lib/license/db.ts` (which is already production); negligible per-cold-start cost.
- **[Risk] JWT verification across rotation drops in-flight tokens** → Mitigation: 24-hour grace window on retired kids.
- **[Risk] Email enumeration via login step 1** → Accepted per contract §5; mitigation is edge rate-limiting (deferred).
- **[Risk] Migration runner applied out-of-order against an existing DB** → Mitigation: filename ordering is lexicographic so zero-padded numeric prefixes sort correctly. Runner refuses to apply if an older migration is unapplied while a newer one is recorded.
- **[Trade-off] No `server_salt` column despite the prompt's table sketch** → argon2's PHC string already encodes the per-row salt and the cost parameters. A separate `server_salt` column would be redundant and dangerous (two sources of truth). Documented in the migration comment.

## Migration Plan

1. **Schema rollout.** Merge PR1; deploy. Run `npm run migrate` against the production Neon instance. Migrations 0001–0004 apply.
2. **Signing key bootstrap.** On the deploy box, run `npx tsx scripts/generate-jwt-keypair.ts --commit`. Copy the printed `ENDSTATE_JWT_PRIVATE_KEY_HEX` and `ENDSTATE_JWT_ACTIVE_KID` into Vercel env. The script also INSERTs the public-key row into `signing_keys`. JWKS endpoint now serves it.
3. **Smoke verification.** `curl https://substratesystems.io/api/.well-known/openid-configuration` → 200 with the `endstate_extensions` block. `curl https://substratesystems.io/api/.well-known/jwks.json` → 200 with one key.
4. **End-to-end smoke.** Use `curl` (or a small script) to signup, complete two-step login, refresh, and call `/api/account/me`. Verify `X-Endstate-API-Version: 1.0` header on each response.
5. **Rollback.** This change is purely additive: new tables, new routes, new lib module. No mutation of license routes or existing data. Rollback = revert the deploy and (optionally) drop the new tables. The license capability is unaffected by all PR1 work.

## Open Questions

- Should we add a synthesised-salt response for login step 1 unknown emails to harden against enumeration? Deferred — current decision is honest 404.
- Should `server_password_hash` and `recovery_key_verifier` use distinct argon2 cost parameters? Currently both use the same low-cost preset. Defensible: the inputs are equivalent in entropy class. Not changing in v1.
