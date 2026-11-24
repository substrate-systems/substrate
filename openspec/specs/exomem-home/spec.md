# exomem-home Specification

## Purpose

Define the private hosted workspace, non-technical onboarding journey, memory interactions, and safe account controls for Exomem owners.

## Requirements

### Requirement: Exomem Home reflects service state honestly

The signed-in Home surface SHALL render one of preparing, awaiting-payment, ready, degraded, suspended, deletion-pending, or deleted states from authoritative control-plane data. It MUST NOT display the ready view before the tenant's cell passes readiness.

#### Scenario: Tenant is provisioning

- **WHEN** the owner's cell is not yet ready
- **THEN** Home shows plain-language deterministic progress, polls a content-free status route, and exposes the support reference

#### Scenario: Tenant is ready

- **WHEN** the entitlement and the cell's readiness both permit service
- **THEN** Home presents connecting an assistant as the primary action, with the tenant's Cloud connector address

#### Scenario: Tenant is suspended

- **WHEN** manual or entitlement suspension is active
- **THEN** Home explains the available recovery and account actions, and never attempts to route around suspension

### Requirement: Portability and account controls are understandable and safe

Home SHALL provide service status, billing source/status, sign-out, and product-scoped deletion. A tenant SHALL get a portable export by asking support. Home SHALL NOT offer a control whose route cannot reach the tenant's cell. Destructive deletion MUST use a fresh single-use confirmation and distinguish queued work from completed destruction.

#### Scenario: Home offers no control that cannot reach the tenant's cell

- **WHEN** a ready Cloud tenant opens Home and uses every control on it
- **THEN** no request goes to a route that reaches only Hosted cells

#### Scenario: Owner requests export

- **WHEN** an owner wants a portable export
- **THEN** they ask support, as the privacy page says, and receive an export encrypted to a key only they hold

#### Scenario: Owner starts deletion

- **WHEN** an owner initiates deletion
- **THEN** Home explains that Exomem data will be removed while unrelated products remain, sends a fresh confirmation, and does not delete on the first click

#### Scenario: Deletion is still destroying storage

- **WHEN** the cell is sealed but external destruction is pending
- **THEN** Home says deletion is in progress and offers no capture/recall surface

### Requirement: Authenticated Home content is private by default

Home, invite redemption, and account pages SHALL be `noindex`, SHALL NOT put vault content or queries into analytics, and SHALL prevent sensitive content from entering server logs, client error reporting, cache keys shared across users, or static rendering artifacts.

#### Scenario: Sensitive content causes a client or server error

- **WHEN** a capture, recall, path, file, or cell response contains a seeded sensitive sentinel
- **THEN** the sentinel is absent from analytics events, operational logs, shared caches, rendered error diagnostics, and request URLs

### Requirement: Home is accessible and resilient for non-technical users

The primary onboarding, connect, status, billing, and deletion flows SHALL support keyboard operation, programmatic labels, visible focus, meaningful loading states, reduced motion, and narrow mobile layouts. Recoverable errors MUST offer one concrete next action.

#### Scenario: User navigates with a keyboard on a narrow screen

- **WHEN** Home is used without a pointer at a mobile viewport
- **THEN** the connect, status, and account controls remain reachable in a logical order without horizontal scrolling

#### Scenario: Recoverable service error occurs

- **WHEN** an action fails with a retryable gateway or lifecycle code
- **THEN** Home explains the next action and displays a copyable support reference

### Requirement: Home names a signed-in app that has gone quiet

A connected app row that reads signed in SHALL say "not used since `<date>`" and "reconnect it in the app if that's unexpected" when the app's last recorded use is at least three days (72 hours) before the reader's current time, computed at render time. The date SHALL be the last recorded use, in the reader's time zone. A row without a readable last use SHALL NOT make this claim. The line SHALL NOT sign the app out, send an email, or add a query to the app list.

#### Scenario: Signed-in app unused for three days

- **WHEN** a signed-in app's last recorded use is 72 hours or more ago
- **THEN** the row reads "not used since `<date>`" and "reconnect it in the app if that's unexpected" instead of "used `<date>`"

#### Scenario: Weekend gap

- **WHEN** a signed-in app's last recorded use is three calendar days ago but less than 72 hours ago
- **THEN** the row reads "used `<date>`"

#### Scenario: No recorded use

- **WHEN** a signed-in app has no recorded last use
- **THEN** the row says nothing about use and makes no quiet claim

#### Scenario: Not signed in

- **WHEN** the app's row reads signed out or sign-in unknown
- **THEN** the row keeps that state's copy, whatever the last use
