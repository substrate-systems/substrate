## ADDED Requirements

### Requirement: Canonical activation response signature

The `/api/license/activate` endpoint MUST sign its response by computing an Ed25519 signature over the SHA-256 digest of the UTF-8 byte concatenation, in this fixed order with no separator:

1. `license_key` — the license key string from the request body, after it has been verified by `decodeAndVerifyLicenseKey`.
2. `fingerprint` — the device fingerprint string from the request body.
3. `activated_at` — the activation timestamp as an ISO 8601 string in UTC (the same string returned in the `activated_at` response field).
4. `expires_at` — the license expiration timestamp as an ISO 8601 string in UTC, OR the empty string `""` for perpetual licenses.

The signature MUST be returned as the response field `signature`, base64-encoded. No other field of the response body changes shape.

#### Scenario: Activation response signature matches canonical contract

- **WHEN** a valid activation request is processed
- **THEN** the response field `signature` is the base64 Ed25519 signature, produced with the server's `ENDSTATE_LICENSE_PRIVATE_KEY`, over `SHA-256(utf8(license_key) || utf8(fingerprint) || utf8(activated_at) || utf8(expires_at_or_empty))`

#### Scenario: Perpetual licenses sign with empty expires_at

- **WHEN** the license being activated has no `expires_at` (perpetual)
- **THEN** the canonical signing payload uses the empty string `""` in place of `expires_at`

#### Scenario: GUI client can verify activation response offline

- **WHEN** the activation response is persisted to the GUI's on-disk license cache and re-verified later (offline)
- **THEN** the cached `signature` field re-verifies against `SHA-256(license_key || fingerprint || activated_at || expires_at_or_empty)` using the embedded Ed25519 public key

### Requirement: signResponseFields not used for license activation or validation

The function `signResponseFields()` in `src/lib/license/crypto.ts` MUST NOT be used to sign the response of `/api/license/activate` or `/api/license/validate`. It remains exported for potential future non-license callers.

#### Scenario: Activation route does not call signResponseFields

- **WHEN** the activate route handler runs
- **THEN** it calls `signActivationCanonical`, not `signResponseFields`

#### Scenario: Validate route does not call signResponseFields

- **WHEN** a `/api/license/validate` route exists and runs
- **THEN** it calls `signActivationCanonical`, not `signResponseFields`

### Requirement: Activation response body shape is unchanged

The activation response body field set, field names, and field order MUST remain identical to the pre-change shape. Only the bytes that produced the `signature` value change.

#### Scenario: Response body is byte-compatible with prior shape

- **WHEN** an activation request returns 200
- **THEN** the response JSON contains the keys `activated`, `instance_id`, `license_id`, `fingerprint`, `activated_at`, `signature`, in that order, with the same types as before
