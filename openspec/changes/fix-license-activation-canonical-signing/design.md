## Context

The license activation flow has two halves that must agree on a single signing payload:

1. **Server (`substrate`)** issues an Ed25519-signed activation response so the GUI can verify it once at activation time and again on every subsequent app start (offline) by re-checking the signature persisted in its on-disk license cache.
2. **GUI (`endstate-gui`)** verifies that signature with `verify_strict` against a deterministically computed 32-byte SHA-256 digest.

The canonical signing payload, per the `2026-04-15-license-migration-paddle-ed25519` design, is:

```
SHA-256( utf8(license_key) || utf8(fingerprint) || utf8(activated_at) || utf8(expires_at_or_empty) )
```

The server today does not produce that. `src/app/api/license/activate/route.ts` calls `signResponseFields()` from `src/lib/license/crypto.ts`, which signs `JSON.stringify({ activated, instance_id, license_id, fingerprint, activated_at })` directly — no SHA-256, different field set, and `license_key` not even part of the input. The signature returned to the GUI cannot be verified by the canonical contract, so every real activation fails after a successful HTTPS round-trip with the GUI surfacing "Verification equation was not satisfied."

The cache half compounds the problem: even if a workaround patched only the GUI verifier today, the GUI's offline re-verification on next launch reads the cached `signature` and re-checks it against the canonical hash. The server has to emit the canonical signature; nothing else round-trips correctly.

Stakeholders: Hugo (only operator), prospective Endstate buyers (every license activation today is broken).

## Goals / Non-Goals

**Goals:**

- Make `/api/license/activate` emit a `signature` field that the GUI's existing canonical verifier accepts, both online and from disk on subsequent launches.
- Lock the canonical bytes with a unit test that breaks loudly if anyone re-introduces JSON-based signing.
- Keep the response body shape byte-compatible so any in-flight client release does not need to change wire format.
- Apply the identical fix to `/api/license/validate` if it exists, so re-validation responses are also verifiable.

**Non-Goals:**

- Adding `expires_at` to the `licenses` table. All current licenses are perpetual; the GUI verifier accepts empty string for that slot.
- Changing the GUI verifier or its cache schema. The GUI is already correct per the canonical contract.
- Removing or refactoring `signResponseFields()`. It stays exported for any future non-license callers — the constraint is just that it MUST NOT be used for license activation/validation responses.
- Migrating signing keys, key rotation, or revocation lists. Out of scope; signing key remains `ENDSTATE_LICENSE_PRIVATE_KEY`.
- Refactoring the activate route's flow (lookup, dedupe, device-limit logic). Only the bytes that produce the `signature` field change.

## Decisions

**Add a new function rather than overloading `signResponseFields`.**
`signResponseFields` is still useful for any future non-license response that wants to sign a JSON envelope. Overloading it to switch to SHA-256-of-concatenation based on a parameter would silently change behavior for every existing caller and obscure the intent at every call site. A dedicated `signActivationCanonical({ licenseKey, fingerprint, activatedAt, expiresAt })` makes the call site self-documenting and limits blast radius. Alternative considered: replace `signResponseFields` outright. Rejected — too easy to regress when adding a future non-license signed response.

**Use `node:crypto.createHash('sha256')` for the digest.**
The crypto path already mixes `@noble/ed25519` (for Ed25519) with `@noble/hashes/sha2` (only because `ed.hashes.sha512` needs to be wired up for the noble lib in Node). For a one-shot 32-byte digest computed only on the server, Node's built-in `node:crypto` is the obvious choice — zero new dependencies, no edge runtime concern (the route already pins `runtime = 'nodejs'`), and easier to reason about than mixing `@noble/hashes/sha2` for a different purpose. Alternative considered: `@noble/hashes/sha2.sha256`. Rejected for no reason to add another path when Node provides it natively.

**Sign the 32-byte digest, not the raw concatenation.**
This matches the GUI verifier exactly: `pubkey.verify_strict(&hash, &sig)` in `src-tauri/src/license.rs`. Signing the raw concatenation would be a slightly different (and equally valid) Ed25519 contract — but it would not match the deployed verifier, so we'd be back to the same problem in a different shape. The contract is "signature over the SHA-256 digest"; we honor it literally.

**`expires_at` defaults to empty string `""`, not `null` or omitted.**
The GUI verifier passes the field as `&str`, so `None`/`null` and "absent" do not exist on the wire — only empty string does. The server must produce the same byte sequence the verifier hashes, so empty string it is. The licenses table has no `expires_at` column today; future expiring-license support would add the column and switch the call site to pass an ISO 8601 string. The function signature accepts `string | null | undefined` to make that future migration a one-line call-site change with no signature surprise (we coerce `null`/`undefined` to `""`).

**Plumb `licenseKey` through `buildActivationResponse` rather than recomputing or attaching it to the response.**
`buildActivationResponse` currently receives `instanceId`, `licenseId`, `fingerprint`, `activatedAt`. Adding `licenseKey` is a single-line signature change and keeps the call ergonomic. Alternative considered: derive `license_key` from `licenseId` via a DB lookup inside the helper. Rejected — extra round-trip for a value already in scope at every call site.

**Lock the bytes with a deterministic test, not just a "happy path" integration test.**
The whole reason this bug shipped is that it wasn't obvious from a Vercel-side test that the signature didn't match what the GUI computes. A deterministic unit test with a fixed seed (`0x42` × 32) and fixed inputs that independently re-derives the canonical hash and the signature, then asserts byte equality with the production function, is the smallest test that breaks loudly on any future drift in either direction (server or canonical contract).

## Risks / Trade-offs

- **[Risk] An older GUI build still verifies the legacy JSON-based signature.** → Mitigation: there is no such build in the wild that successfully verified — the legacy contract did not match what the GUI does today, so no real customer was ever activated. Confirmed by the bug report itself ("every real activation fails"). No backwards-compatibility burden.
- **[Risk] `expires_at: ""` differs from a future `expires_at: "2099-12-31T..."` in a way that silently invalidates older perpetual licenses.** → Mitigation: any future expiring-license migration must keep perpetual rows on `""` and only emit a real ISO string for new expiring rows. Adding `expires_at` to the `licenses` table is a separate proposal; this proposal explicitly does not introduce expiry semantics.
- **[Risk] An unreviewed second route (e.g. `/api/license/refresh`) still uses `signResponseFields` for a license response.** → Mitigation: the spec delta explicitly forbids this in the activate AND validate routes; the implementation step greps for all `signResponseFields` callers and reports them. A future caller would have to opt in by name.
- **[Trade-off] We are not deleting `signResponseFields`.** A future engineer could call it incorrectly. → Trade-off accepted: deletion would remove a primitive that has plausible non-license uses. The spec delta and the dedicated `signActivationCanonical` name make the right path obvious at the call site.

## Migration Plan

1. Land the change in `substrate`. Vercel auto-deploys on push to `main`.
2. From the GUI on a clean machine: clear the on-disk license cache, paste the email license key, click Activate. Expect 200 + activated state.
3. Force-quit and relaunch the GUI to exercise the offline re-verification path against the cached signature. Expect activated state without a network call.
4. **Rollback**: revert the commit. Server reverts to the legacy JSON-based signature; activation goes back to failing as before. No data is corrupted — the activation row in `licenses` is unchanged in either direction; only the bytes signed in the response differ.
5. Archive the OpenSpec change after the GUI verifies end-to-end.

## Open Questions

- None. The canonical contract is fixed by the `2026-04-15-license-migration-paddle-ed25519` design and by the GUI's `canonical_hash` implementation in `src-tauri/src/license.rs`; this proposal aligns the server with that single source of truth.
