## ADDED Requirements

### Requirement: Account profile endpoint

The system SHALL expose `GET /api/account/me` returning the authenticated user's `{ userId, email, subscriptionStatus, createdAt }`. The endpoint requires a valid access token in the `Authorization: Bearer <token>` header.

#### Scenario: Authenticated request returns the profile
- **WHEN** a `GET /api/account/me` request is made with a valid access token
- **THEN** the response is HTTP 200 with body keys `userId`, `email`, `subscriptionStatus`, `createdAt`

#### Scenario: Missing token returns 401
- **WHEN** a `GET /api/account/me` request is made without an `Authorization` header
- **THEN** the response is HTTP 401 and `error.code` is `UNAUTHENTICATED`

#### Scenario: Invalid token returns 401
- **WHEN** a `GET /api/account/me` request is made with a malformed or expired access token
- **THEN** the response is HTTP 401 and `error.code` is `INVALID_TOKEN` or `TOKEN_EXPIRED`

#### Scenario: subscriptionStatus is one of the four locked values
- **WHEN** a successful `GET /api/account/me` response is returned
- **THEN** `subscriptionStatus` is one of `"none"`, `"active"`, `"grace"`, `"cancelled"`

#### Scenario: Response includes API version header
- **WHEN** a `GET /api/account/me` response is returned
- **THEN** the response includes header `X-Endstate-API-Version: 1.0`
