## 1. Pre-flight Reconnaissance

- [x] 1.1 Read `src/lib/license/crypto.ts` end-to-end and confirm `signBytes`, `bytesToBase64`, and the existing `signResponseFields` shape.
- [x] 1.2 Read `src/app/api/license/activate/route.ts` end-to-end and confirm `buildActivationResponse` is the only place the response signature is produced.
- [x] 1.3 Grep the repo for `signResponseFields` callers; report every usage with file:line.
- [x] 1.4 Check whether `src/app/api/license/validate/route.ts` (or any other re-validation route) exists; if so, list the call site that signs the response.

## 2. Crypto Primitive

- [x] 2.1 In `src/lib/license/crypto.ts`, add an exported `signActivationCanonical({ licenseKey, fingerprint, activatedAt, expiresAt })` function returning `Promise<string>`.
- [x] 2.2 Build the byte buffer as `concat(utf8(licenseKey), utf8(fingerprint), utf8(activatedAt), utf8(expiresAt ?? ""))` using the module's existing `TextEncoder` and `Buffer.concat`.
- [x] 2.3 Hash with `crypto.createHash('sha256').update(buf).digest()` from `node:crypto`. Confirm the output is 32 bytes.
- [x] 2.4 Pass the 32-byte digest to `signBytes` and return its base64 form via `bytesToBase64`.
- [x] 2.5 Leave `signResponseFields` exported and unchanged.

## 3. Activate Route Wiring

- [x] 3.1 In `src/app/api/license/activate/route.ts`, add `licenseKey: string` to the `buildActivationResponse` parameter object.
- [x] 3.2 Inside `buildActivationResponse`, replace the `signResponseFields(fields)` call with `signActivationCanonical({ licenseKey: params.licenseKey, fingerprint: params.fingerprint, activatedAt: activatedAtIso, expiresAt: "" })`.
- [x] 3.3 At every existing call site of `buildActivationResponse` in this file, pass `licenseKey: license.license_key` (or the appropriate in-scope license key string).
- [x] 3.4 Confirm the response JSON keys, order, and types are byte-compatible with the pre-change shape (only the `signature` value changes meaning).
- [x] 3.5 Remove the `signResponseFields` import from this route if it's now unused.

## 4. Validate Route (conditional)

- [x] 4.1 If `src/app/api/license/validate/route.ts` exists, repeat the swap there: replace `signResponseFields` with `signActivationCanonical` using `licenseKey` (request body), `fingerprint` (cache or request), `activatedAt` (DB or request), `expiresAt: ""` (until table gets the column).
- [x] 4.2 If no validate route exists, document this in the implementation report; no further action.

## 5. Lock-the-Bytes Test

- [x] 5.1 Create `src/lib/license/__tests__/canonical-signing.test.ts` (create the `__tests__` folder if absent).
- [x] 5.2 In a `beforeAll`, set `process.env.ENDSTATE_LICENSE_PRIVATE_KEY = "42".repeat(32)` so the production code derives a known keypair.
- [x] 5.3 Define fixed inputs: `licenseKey: "test-key"`, `fingerprint: "test-fp"`, `activatedAt: "2026-01-01T00:00:00Z"`, `expiresAt: ""`.
- [x] 5.4 Independently compute the canonical hash with `node:crypto` and sign it with `@noble/ed25519` using a freshly-derived keypair from the same hex seed.
- [x] 5.5 Call `signActivationCanonical` with the same inputs and assert the base64 signatures are equal byte-for-byte.
- [x] 5.6 Add an extra assertion that swapping `fingerprint` to `"OTHER"` produces a different signature, to catch any silent payload-ordering bug.

## 6. Build & Test Verification

- [x] 6.1 `npm run build` — must pass.
- [x] 6.2 `npm test` (or whatever the project's test command is) — must pass, including the new test.
- [x] 6.3 `git status` — confirm only the expected files changed (proposal/specs/design/tasks for OpenSpec, plus crypto.ts + activate route + new test file).
- [x] 6.4 Report `git diff --stat` and the test output (with the new test name visible) back to the operator.

## 7. Hand-off

- [ ] 7.1 Do NOT run `/opsx:apply` or `/opsx:archive`. Operator reviews proposal/design/spec deltas, then commits and pushes manually.
- [ ] 7.2 After Vercel deploy: operator clears the GUI's on-disk license cache, retries activation with the email license key, and confirms a fresh activation succeeds AND a relaunch of the GUI re-verifies offline against the cached signature.
