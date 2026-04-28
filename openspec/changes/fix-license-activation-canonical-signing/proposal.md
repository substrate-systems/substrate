## Why

The `/api/license/activate` route currently signs a JSON object — `JSON.stringify({ activated, instance_id, license_id, fingerprint, activated_at })` via `signResponseFields()` — and returns that signature in the response body. The Endstate GUI client, per the canonical contract documented in the `2026-04-15-license-migration-paddle-ed25519` design, instead verifies the response by computing `SHA-256(license_key || fingerprint || activated_at || expires_at)` and Ed25519-verifying against that 32-byte digest. The two signing payloads do not match. As a result every real activation in production fails the GUI's `verify_strict` check with "Verification equation was not satisfied," which blocks license activation entirely.

The same canonical hash is used by the GUI's offline cache re-verification path. Whatever signature the server emits at activation time is persisted to disk and re-checked offline on every subsequent app start. So the fix is not just "match the verifier today" — it is "match the canonical contract that both the verifier and the offline cache depend on."

## What Changes

- Add `signActivationCanonical({ licenseKey, fingerprint, activatedAt, expiresAt })` to `src/lib/license/crypto.ts`. It computes `SHA-256(utf8(licenseKey) || utf8(fingerprint) || utf8(activatedAt) || utf8(expiresAt ?? ""))` and returns the base64 Ed25519 signature over that 32-byte digest.
- `/api/license/activate` switches from `signResponseFields` to `signActivationCanonical`. The response body shape (field set, field order, field names) is unchanged; only the bytes signed change. `licenseKey` is plumbed through `buildActivationResponse` as a new parameter.
- `expires_at` is `""` for now — the `licenses` table has no `expires_at` column, all licenses are perpetual, and the GUI verifier already treats empty string the same as the absent field.
- If a `/api/license/validate` route exists at the time of implementation, the same fix applies there.
- `signResponseFields` stays exported. It must NOT be used for license activation/validation responses, but it can remain available for any other future callers.
- A new unit test at `src/lib/license/__tests__/canonical-signing.test.ts` locks the canonical bytes by independently computing the expected signature with the same Ed25519 keypair and asserting equality.

## Capabilities

### Modified Capabilities

- `license-activation`: change the bytes signed in the activation response to match the canonical contract verified by the GUI client and its offline cache.

## Impact

- `src/lib/license/crypto.ts` — adds one exported function.
- `src/app/api/license/activate/route.ts` — single function call swap; `buildActivationResponse` gains one parameter.
- `src/app/api/license/validate/route.ts` — same swap, if present.
- `src/lib/license/__tests__/canonical-signing.test.ts` — new test file.
- No DB schema changes. No env-var changes. No new dependencies (uses existing `@noble/ed25519` plus Node's built-in `node:crypto`).
- No GUI changes — the GUI verifier is already correct per the canonical contract.
