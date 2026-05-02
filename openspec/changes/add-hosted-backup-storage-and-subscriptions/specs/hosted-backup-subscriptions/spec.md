## ADDED Requirements

### Requirement: Subscription state machine

The system SHALL maintain one row per user in the `subscriptions` table with `status` constrained to `none`, `active`, `grace`, or `cancelled`. Transitions are driven by Paddle webhook events per contract §10.

#### Scenario: subscription.created transitions none → active
- **GIVEN** a user with `status = "none"` (or no subscription row)
- **WHEN** a `subscription.created` event for that user's `paddle_customer_id` is processed
- **THEN** the user's `subscriptions.status` is `active`

#### Scenario: subscription.past_due transitions active → grace
- **GIVEN** a user with `status = "active"`
- **WHEN** a `subscription.past_due` event is processed
- **THEN** the user's `subscriptions.status` is `grace` AND `grace_started_at` is set

#### Scenario: subscription.activated transitions grace → active
- **GIVEN** a user with `status = "grace"`
- **WHEN** a `subscription.activated` event is processed
- **THEN** the user's `subscriptions.status` is `active`

#### Scenario: subscription.canceled transitions active → cancelled
- **GIVEN** a user with `status = "active"`
- **WHEN** a `subscription.canceled` event (Paddle's spelling) is processed
- **THEN** the user's `subscriptions.status` is `cancelled` (internal spelling, two l's) AND `cancel_started_at` is set

### Requirement: Paddle webhook signature verification

`POST /api/webhooks/paddle` SHALL verify the `Paddle-Signature` header against the raw request body using the existing `verifyPaddleSignature` utility from `src/lib/license/paddle.ts`. Invalid, tampered, or missing signatures SHALL return HTTP 401.

#### Scenario: Valid signature is accepted
- **WHEN** a webhook arrives with a valid signature for the body
- **THEN** the response is HTTP 200 and the event is processed

#### Scenario: Invalid signature returns 401
- **WHEN** a webhook arrives with a signature that does not match the body
- **THEN** the response is HTTP 401 and the event is not processed

#### Scenario: Tampered body returns 401
- **WHEN** a webhook's body is modified after signing
- **THEN** the response is HTTP 401

#### Scenario: Missing Paddle-Signature header returns 401
- **WHEN** a webhook arrives without the `Paddle-Signature` header
- **THEN** the response is HTTP 401

### Requirement: Webhook idempotency

The system SHALL process each Paddle event at most once, keyed by `event_id`. Duplicate events SHALL return HTTP 200 without re-applying any state change.

#### Scenario: Same event_id processed twice
- **WHEN** the same Paddle event (identified by `event_id`) is delivered twice
- **THEN** both responses are HTTP 200 AND only one row exists in `paddle_webhook_events` AND any state-machine transition triggered by the event is applied exactly once

### Requirement: Unknown event types are tolerated

The system SHALL return HTTP 2xx for any well-signed webhook event, including event types it does not act on. Unknown event types are logged but do not trigger retries.

#### Scenario: Unknown event_type returns 200
- **WHEN** a webhook for an event type not in the contract §10 mapping is received with a valid signature
- **THEN** the response is HTTP 200 AND a `console.warn` entry mentions the unknown event type

### Requirement: subscription_status JWT claim sourced from real subscriptions row

The `subscription_status` claim in JWT access tokens SHALL be sourced from `SELECT status FROM subscriptions WHERE user_id = $1`, returning `'none'` if no row exists. The claim is a hint with up to 15-minute staleness; route-layer authorisation SHALL re-read the DB.

#### Scenario: JWT claim reflects DB row at mint time
- **GIVEN** a user with `subscriptions.status = "active"` in the DB
- **WHEN** the user logs in and a fresh access token is minted
- **THEN** the token's `subscription_status` claim is `"active"`

#### Scenario: Route check uses live DB read
- **GIVEN** a user holding a JWT with `subscription_status = "active"` whose DB row has since transitioned to `"grace"`
- **WHEN** the user calls `POST /api/backups`
- **THEN** the response is HTTP 402 `SUBSCRIPTION_REQUIRED` (route enforces against the DB row, not the JWT claim)

### Requirement: Write/read gating per state

The system SHALL gate write paths (`POST /api/backups`, `POST .../versions`) on `status = "active"`. Read paths (`GET .../versions`, `POST .../download-urls`, `DELETE .../versions/:versionId`, `DELETE /api/backups/:backupId`) SHALL allow `active`, `grace`, and `cancelled`. All routes SHALL block `status = "none"`.

#### Scenario: Write blocked in grace
- **WHEN** a user with `status = "grace"` calls `POST /api/backups/:backupId/versions`
- **THEN** the response is HTTP 402 and `error.code` is `SUBSCRIPTION_REQUIRED`

#### Scenario: Read allowed in cancelled
- **WHEN** a user with `status = "cancelled"` calls `POST /api/backups/:backupId/versions/:versionId/download-urls`
- **THEN** the response is HTTP 200 with download URLs

#### Scenario: All paths blocked in none
- **WHEN** a user with `status = "none"` calls any `/api/backups/*` route
- **THEN** the response is HTTP 402 and `error.code` is `SUBSCRIPTION_REQUIRED`

### Requirement: API version header on webhook responses

`POST /api/webhooks/paddle` responses SHALL include `X-Endstate-API-Version: 1.0`.

#### Scenario: Webhook responses are versioned
- **WHEN** the webhook handler returns any response
- **THEN** the response includes header `X-Endstate-API-Version: 1.0`
