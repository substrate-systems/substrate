## ADDED Requirements

### Requirement: Staging is a stable isolated deployment

Exomem Hosted SHALL provide one stable staging deployment on the existing Vercel project whose branch, public origin, non-production Postgres database/schema, Paddle environment, webhook secret, sessions, and capacity ledger are distinct from production. Staging MUST NOT accept Paddle Live credentials or catalog resources and MUST NOT mutate production control-plane rows or pre-existing verification-schema rows.

#### Scenario: Staging branch deploys

- **WHEN** the exact `staging` branch is deployed with its branch-scoped Preview configuration
- **THEN** `staging.substratesystems.io` serves that deployment using the exact staging database/search path and Paddle Sandbox
- **AND** production remains on its existing domain, database, and Paddle Live environment

#### Scenario: Arbitrary preview deploys

- **WHEN** any branch other than `staging` creates a Vercel Preview
- **THEN** it does not gain the staging migration authority or stable staging domain

#### Scenario: Staging is configured with a production credential

- **WHEN** the staging deployment detects a Paddle Live credential, Live client token, Live catalog environment, production public origin, or a database name outside its staging contract
- **THEN** deployment or paid checkout fails closed before a migration, transaction, or entitlement mutation

### Requirement: Staging migrations are branch-bound and additive

The deployment migration runner SHALL apply pending additive migrations to staging only when the Vercel environment, Git branch, explicit staging flag, configured database name, and configured schema search path all match. Production migration behavior SHALL remain unchanged, and other Preview deployments SHALL skip migrations.

#### Scenario: Exact staging deployment runs migrations

- **WHEN** a Preview build declares the `staging` branch, enables the staging contract, and names the expected staging database and schema search path
- **THEN** the normal serialized migration runner applies pending migrations to that isolated schema before the application build

#### Scenario: Preview contract is incomplete

- **WHEN** any staging migration guard is missing or mismatched
- **THEN** the build refuses to apply migrations and reports only the mismatched guard class

#### Scenario: Normal preview builds

- **WHEN** an ordinary feature branch is built without the explicit staging contract
- **THEN** migrations are skipped as before

### Requirement: The staging acceptance journey uses real sandbox boundaries

The staging release proof SHALL use an operator-issued paid invitation, Paddle Sandbox checkout and webhook delivery, the real lifecycle reconciler and provisioner, and a real MCP capture/recall round trip. It SHALL verify payment precedes provisioning, retries converge exactly once, the portal opens, and production records remain unchanged.

#### Scenario: Paid sandbox journey completes

- **WHEN** an operator redeems a staging paid invite and completes Paddle Sandbox checkout with a test payment method
- **THEN** redemption first creates a reservation without a provision operation
- **AND** verified Sandbox activation creates exactly one initial provision operation and one ready isolated cell
- **AND** the owner can capture, recall in a fresh chat, and open the Paddle Sandbox customer portal

#### Scenario: Sandbox delivery is replayed

- **WHEN** the accepted Paddle event is delivered twice and an older subscription update follows
- **THEN** the control plane records one applied transition, one duplicate disposition, one stale disposition, and no second provision operation

#### Scenario: Acceptance evidence is retained

- **WHEN** the staging proof completes or fails
- **THEN** the operator record contains only deployment revision, environment, stable outcomes, counts, and redacted timing evidence
- **AND** it contains no email, session, tenant, provider resource, transaction, customer, subscription, credential, or memory content
