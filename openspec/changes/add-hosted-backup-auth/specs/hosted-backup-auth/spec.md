## ADDED Requirements

### Requirement: KDF parameter floor enforcement

The system SHALL reject any signup or recovery-finalize request whose `kdfParams` are weaker than: algorithm `argon2id`, memory ≥ 65536 KiB, iterations ≥ 3, parallelism ≥ 4. Floor violations return HTTP 400 with error code `KDF_TOO_WEAK`.

#### Scenario: Signup below memory floor is rejected
- **WHEN** a signup request supplies `kdfParams.memory = 32768`
- **THEN** the response is HTTP 400 and `error.code` is `KDF_TOO_WEAK`

#### Scenario: Signup below iteration floor is rejected
- **WHEN** a signup request supplies `kdfParams.iterations = 2`
- **THEN** the response is HTTP 400 and `error.code` is `KDF_TOO_WEAK`

#### Scenario: Signup with non-argon2id algorithm is rejected
- **WHEN** a signup request supplies `kdfParams.algorithm = "scrypt"`
- **THEN** the response is HTTP 400 and `error.code` is `KDF_TOO_WEAK`

#### Scenario: Recovery finalize re-enforces the floor
- **WHEN** a recovery-finalize request supplies `newKdfParams.parallelism = 1`
- **THEN** the response is HTTP 400 and `error.code` is `KDF_TOO_WEAK`

### Requirement: Signup endpoint

The system SHALL expose `POST /api/auth/signup` accepting a JSON body `{ email, serverPassword, salt, kdfParams, wrappedDEK, recoveryKeyVerifier, recoveryKeyWrappedDEK }`. On success, the response is HTTP 200 with body `{ userId, accessToken, refreshToken }`.

#### Scenario: Successful signup creates user and returns tokens
- **WHEN** a valid signup request is submitted
- **THEN** the response is HTTP 200 with body keys `userId`, `accessToken`, `refreshToken`

#### Scenario: Duplicate email returns 409
- **WHEN** a signup request reuses an existing user's email (case-insensitive)
- **THEN** the response is HTTP 409 and `error.code` is `EMAIL_TAKEN`

#### Scenario: Server-side hash uses argon2id
- **WHEN** a signup completes successfully
- **THEN** the persisted `auth_credentials.server_password_hash` is an argon2id PHC string starting with `$argon2id$`

### Requirement: Two-step login

The system SHALL expose `POST /api/auth/login` that handles both pre-handshake (request body has only `email`) and complete (request body has `email` and `serverPassword`).

Step-1 success returns `{ salt, kdfParams }`. Step-2 success returns `{ userId, accessToken, refreshToken, wrappedDEK }`.

#### Scenario: Step 1 returns the user's salt and kdf params
- **WHEN** a login request body is `{ "email": "<existing>" }`
- **THEN** the response is HTTP 200 with keys `salt` and `kdfParams`

#### Scenario: Step 1 with unknown email returns 404
- **WHEN** a login request body is `{ "email": "<unknown>" }`
- **THEN** the response is HTTP 404 and `error.code` is `EMAIL_NOT_FOUND`

#### Scenario: Step 2 with valid serverPassword returns tokens and wrappedDEK
- **WHEN** a login step-2 request supplies the correct `serverPassword`
- **THEN** the response is HTTP 200 with keys `userId`, `accessToken`, `refreshToken`, `wrappedDEK`

#### Scenario: Step 2 with wrong serverPassword returns 401
- **WHEN** a login step-2 request supplies an incorrect `serverPassword`
- **THEN** the response is HTTP 401 and `error.code` is `INVALID_CREDENTIALS`

### Requirement: Refresh rotation with reuse detection

The system SHALL expose `POST /api/auth/refresh` that consumes a refresh token and returns a new pair. Each refresh issues a child token whose `parent_id` is the consumed token. If a refresh token that has already been revoked is presented, the system SHALL revoke the entire chain (every token sharing the same `chain_id`) and return HTTP 401.

#### Scenario: Fresh rotation issues a new pair
- **WHEN** an unrevoked refresh token is presented
- **THEN** the response is HTTP 200 with keys `accessToken`, `refreshToken`, AND the presented token is marked revoked

#### Scenario: Reused refresh token revokes the chain
- **WHEN** a refresh token that has already been revoked is presented
- **THEN** the response is HTTP 401, `error.code` is `REFRESH_REUSE_DETECTED`, AND every token in the same `chain_id` is revoked

#### Scenario: Refresh chain is capped at 30 days
- **WHEN** a refresh token whose chain root was issued more than 30 days ago is presented
- **THEN** the response is HTTP 401 and `error.code` is `REFRESH_EXPIRED`

### Requirement: Logout

The system SHALL expose `POST /api/auth/logout` accepting `{ refreshToken }` and revoking the presented refresh token. The endpoint is idempotent — already-revoked or unknown tokens still return `{ ok: true }`.

#### Scenario: Logout revokes the presented token
- **WHEN** a logout request is made with a valid unrevoked refresh token
- **THEN** the response is HTTP 200 with body `{ ok: true }` AND the token is marked revoked

#### Scenario: Logout is idempotent
- **WHEN** a logout request is made with an already-revoked refresh token
- **THEN** the response is HTTP 200 with body `{ ok: true }`

### Requirement: Two-step recovery

The system SHALL expose `POST /api/auth/recover` accepting `{ email, recoveryKeyProof }` and `POST /api/auth/recover/finalize` accepting `{ recoveryToken, newServerPassword, newSalt, newKdfParams, newWrappedDEK }`.

The `recoveryToken` is a short-lived JWT with `aud = "endstate-recover"` and `exp = iat + 300`.

`recover/finalize` SHALL update `auth_credentials.server_password_hash`, `client_salt`, `kdf_params`, and `wrapped_dek` in a single transaction, AND revoke every existing refresh chain for the user.

#### Scenario: Recover step 1 with valid proof returns recovery token and wrapped DEK
- **WHEN** a recover request supplies a `recoveryKeyProof` that verifies against the stored `recovery_key_verifier`
- **THEN** the response is HTTP 200 with keys `recoveryToken`, `recoveryKeyWrappedDEK`

#### Scenario: Recover step 1 with invalid proof returns 401
- **WHEN** a recover request supplies a `recoveryKeyProof` that does not verify
- **THEN** the response is HTTP 401 and `error.code` is `INVALID_RECOVERY_KEY`

#### Scenario: Finalize updates credentials and issues fresh tokens
- **WHEN** a recover-finalize request with a valid recovery token completes
- **THEN** the response is HTTP 200 with keys `accessToken`, `refreshToken`, AND `auth_credentials` reflects the new password hash, salt, kdf params, and wrapped DEK, AND every prior refresh chain for the user is revoked

#### Scenario: Finalize rejects expired recovery token
- **WHEN** a recover-finalize request supplies a recovery token whose `exp` has passed
- **THEN** the response is HTTP 401 and `error.code` is `RECOVERY_TOKEN_EXPIRED`

### Requirement: JWT issuance shape

Every access token issued by the system SHALL be a JWT with header `{ "alg": "EdDSA", "typ": "JWT", "kid": <env active kid> }` and claims `{ iss, sub, aud, iat, exp, nbf, jti, subscription_status }` where `aud = "endstate-backup"`, `iss = process.env.ENDSTATE_OIDC_ISSUER_URL || "https://substratesystems.io"`, `exp = iat + 900`, `nbf = iat`, `jti` is a fresh UUID.

#### Scenario: Issued JWT has the locked claims
- **WHEN** an access token is issued
- **THEN** decoded JWT claims contain `aud = "endstate-backup"`, `iss = "https://substratesystems.io"` (or the env-configured issuer), `exp - iat = 900`, `nbf = iat`, AND `jti` is a UUID

#### Scenario: Issued JWT header references the active kid
- **WHEN** an access token is issued
- **THEN** the decoded JWT header has `alg = "EdDSA"`, `typ = "JWT"`, and `kid` equal to `ENDSTATE_JWT_ACTIVE_KID`

### Requirement: JWT validation rules

The system SHALL reject access tokens with wrong audience, wrong issuer, expired (`exp <= now`), not-yet-valid (`nbf > now`), unknown `kid`, or tampered signature. Recently-retired kids (retired within 24 hours) SHALL still validate.

#### Scenario: Wrong audience is rejected
- **WHEN** a JWT with `aud = "wrong-audience"` is presented to a protected route
- **THEN** the response is HTTP 401 and `error.code` is `INVALID_TOKEN`

#### Scenario: Expired token is rejected
- **WHEN** a JWT with `exp` in the past is presented to a protected route
- **THEN** the response is HTTP 401 and `error.code` is `TOKEN_EXPIRED`

#### Scenario: Tampered signature is rejected
- **WHEN** a JWT whose payload was modified after signing is presented
- **THEN** the response is HTTP 401 and `error.code` is `INVALID_TOKEN`

#### Scenario: Unknown kid is rejected
- **WHEN** a JWT whose header `kid` does not appear in `signing_keys` is presented
- **THEN** the response is HTTP 401 and `error.code` is `INVALID_TOKEN`

#### Scenario: Recently retired kid still validates
- **WHEN** a JWT signed with a kid retired less than 24 hours ago is presented
- **THEN** the response is HTTP 200 (token validates)

### Requirement: OIDC discovery endpoint

The system SHALL expose `GET /api/.well-known/openid-configuration` returning a JSON document with at minimum `issuer`, `jwks_uri`, `id_token_signing_alg_values_supported`, AND a non-empty `endstate_extensions` block per contract §9.

The `endstate_extensions` block SHALL contain `auth_signup_endpoint`, `auth_login_endpoint`, `auth_refresh_endpoint`, `auth_logout_endpoint`, `auth_recover_endpoint`, `backup_api_base`, `supported_kdf_algorithms`, `supported_envelope_versions`, AND `min_kdf_params`.

#### Scenario: Discovery payload has the standard OIDC fields
- **WHEN** a GET to `/api/.well-known/openid-configuration` is made
- **THEN** the response body has keys `issuer`, `jwks_uri`, AND `id_token_signing_alg_values_supported` containing `"EdDSA"`

#### Scenario: Discovery payload has the endstate_extensions block
- **WHEN** a GET to `/api/.well-known/openid-configuration` is made
- **THEN** `endstate_extensions.supported_kdf_algorithms` contains `"argon2id"` AND `endstate_extensions.min_kdf_params` equals `{ memory: 65536, iterations: 3, parallelism: 4 }`

#### Scenario: Discovery is cacheable
- **WHEN** a GET to `/api/.well-known/openid-configuration` is made
- **THEN** the `Cache-Control` header is `public, s-maxage=300, stale-while-revalidate=60`

### Requirement: JWKS endpoint

The system SHALL expose `GET /api/.well-known/jwks.json` returning `{ keys: [...] }` where each entry is an OKP JWK with `kty: "OKP"`, `crv: "Ed25519"`, `alg: "EdDSA"`, `use: "sig"`, `kid`, AND `x` (base64url-encoded public key).

The endpoint SHALL include keys whose `retired_at IS NULL OR retired_at > now() - interval '24 hours'`.

#### Scenario: JWKS contains the active key
- **WHEN** a GET to `/api/.well-known/jwks.json` is made
- **THEN** the response `keys` array contains an entry whose `kid` equals `ENDSTATE_JWT_ACTIVE_KID`

#### Scenario: JWKS entries are well-formed
- **WHEN** a GET to `/api/.well-known/jwks.json` is made
- **THEN** every entry in `keys` has `kty: "OKP"`, `crv: "Ed25519"`, `alg: "EdDSA"`, `use: "sig"`, AND a base64url-encoded `x`

#### Scenario: Retired-long-ago keys are excluded
- **WHEN** a signing key was retired more than 24 hours ago
- **THEN** it does not appear in the JWKS response

### Requirement: API version header

Every JSON response from a route under `/api/auth/` or `/api/.well-known/` SHALL include the response header `X-Endstate-API-Version: 1.0`.

#### Scenario: Auth endpoints emit the version header
- **WHEN** any `/api/auth/*` endpoint returns a JSON response
- **THEN** the response includes header `X-Endstate-API-Version: 1.0`

#### Scenario: Discovery endpoints emit the version header
- **WHEN** `/api/.well-known/openid-configuration` or `/api/.well-known/jwks.json` returns a response
- **THEN** the response includes header `X-Endstate-API-Version: 1.0`
