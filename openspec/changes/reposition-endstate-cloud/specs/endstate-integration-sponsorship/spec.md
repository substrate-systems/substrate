## ADDED Requirements

### Requirement: A sponsor-an-integration page explains what sponsorship funds

The site SHALL serve a page at `/endstate/sponsor-an-integration` that explains
integration sponsorship. It SHALL carry the following explanation verbatim:

> Endstate already reinstalls applications through WinGet and Chocolatey.
> Integration sponsorship funds deeper migration support: safe settings capture
> and restore, version handling, package-identity edge cases, testing, and
> documentation.

The page SHALL distinguish package installation from migration support.

#### Scenario: The page is served

- **WHEN** an HTTP GET request is made to `/endstate/sponsor-an-integration`
- **THEN** the system responds with HTTP 200

#### Scenario: The central explanation is present verbatim

- **WHEN** the page is rendered
- **THEN** it contains the explanation above word for word

#### Scenario: Installation and migration are distinguished

- **WHEN** the page is rendered
- **THEN** it explains that package installation is already handled, and that
  migration support — which settings are safe to move, how they differ across
  versions and editions, and verifying the round trip — is the work being funded

### Requirement: The page states the limits of a sponsorship

The page SHALL state that ordinary Endstate development and community
contributions continue; that sponsorship buys priority, explicit scope, and
verification; that public integrations become part of free, open-source
Endstate; that private organisational and vendor integrations are available by
quotation; that a completed sponsorship does not imply lifetime maintenance; and
that ongoing compatibility guarantees require a separate agreement.

#### Scenario: Continuing development is stated

- **WHEN** the page is rendered
- **THEN** it states that ordinary development and community contributions
  continue regardless of sponsorship

#### Scenario: What sponsorship buys is stated

- **WHEN** the page is rendered
- **THEN** it states that sponsorship buys priority, explicit scope, and
  verification

#### Scenario: Public integrations are stated to be free and open source

- **WHEN** the page is rendered
- **THEN** it states that a sponsored public integration becomes part of free,
  open-source Endstate

#### Scenario: Private and vendor work is by quotation

- **WHEN** the page is rendered
- **THEN** it states that private organisational and vendor integrations are
  available by quotation

#### Scenario: Maintenance is not implied

- **WHEN** the page is rendered
- **THEN** it states that a completed sponsorship does not imply lifetime
  maintenance
- **AND** it states that ongoing compatibility guarantees require a separate
  agreement

### Requirement: Integration sponsorship carries no public fixed price

The page SHALL NOT publish a fixed price for integration sponsorship. Its call
to action SHALL be a request for a quote.

#### Scenario: No price is published

- **WHEN** the page is rendered
- **THEN** it shows no fixed sponsorship price
- **AND** its call to action reads "Request a quote"

### Requirement: Intake reuses the existing contact pipeline

Intake SHALL be a structured `mailto:founder@substratesystems.io` link with a
prefilled subject and a body template. The body template SHALL collect only:
application name; vendor and product URL; version or edition; current operating
system; installation source or package identity; settings or state that must
survive migration; whether the integration may be public; deadline or business
context; and contact name and email.

The change SHALL NOT introduce a backend service, API route, database table, or
third-party form, and SHALL NOT introduce a marketplace, pooled funding, bounty
accounting, vendor certification, automated pricing, module ownership, or an
issue tracker.

#### Scenario: The request link is a structured mail draft

- **WHEN** the request-a-quote link is rendered
- **THEN** its target is a `mailto:founder@substratesystems.io` address with a
  prefilled subject and a body containing each of the listed fields

#### Scenario: No new intake surface exists

- **WHEN** the change is deployed
- **THEN** no new API route, database table, or third-party form handles
  sponsorship enquiries

### Requirement: The page is discoverable

The Endstate footer SHALL link to `/endstate/sponsor-an-integration`, and the
sitemap SHALL include it. The page SHALL emit page metadata and breadcrumb
structured data consistent with the other Endstate subpages.

#### Scenario: The footer links to the page

- **WHEN** any page rendering the Endstate footer is rendered
- **THEN** the footer contains a link with href `/endstate/sponsor-an-integration`

#### Scenario: The sitemap includes the page

- **WHEN** the sitemap is generated
- **THEN** it contains an entry for
  `https://substratesystems.io/endstate/sponsor-an-integration`

#### Scenario: The page emits metadata and breadcrumbs

- **WHEN** the page is rendered
- **THEN** it emits a title, description, canonical URL, and Open Graph image
- **AND** it emits `BreadcrumbList` structured data for Home, Endstate, and
  Sponsor an integration
