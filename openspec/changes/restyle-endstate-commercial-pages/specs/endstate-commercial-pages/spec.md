## ADDED Requirements

### Requirement: Commercial Endstate routes use the landing-page visual grammar

The `/endstate/supporters` and `/endstate/sponsor-an-integration` routes SHALL
use the existing Endstate palette, typography, navigation, footer, page-local
inline-style approach, and wide commercial composition. They SHALL remain
server-rendered and SHALL preserve a single-column mobile layout.

#### Scenario: A commercial route is rendered

- **WHEN** either commercial Endstate route is rendered
- **THEN** its hero and commercial sections use a content width of approximately
  1100 pixels
- **AND** it uses restrained bordered cards or panels for related content
- **AND** it retains the shared Endstate navigation and footer

### Requirement: Supporters are presented as consented recognition

The supporters route SHALL present a composed support hero, a contained
supporter roster, the existing contribution choices, and a contained closing
note. It SHALL continue to list only the canonical opt-in names from
`SUPPORTERS.md` and SHALL not display contribution amount, transaction data, or
an inferred tier.

#### Scenario: Supporters are available

- **WHEN** the canonical supporter source yields names
- **THEN** the route renders those names in a dedicated roster surface
- **AND** it states that recognition is opt-in

#### Scenario: Supporter retrieval is unavailable

- **WHEN** the canonical supporter source cannot be fetched or parsed
- **THEN** the route renders a contained empty-state surface with a link to the
  existing contribution section

### Requirement: Integration sponsorship explains the decision before the quote

The integration-sponsorship route SHALL present a strong hero with the existing
request-a-quote mailto call to action, a two-column installation-versus-migration
comparison, three cards for priority, explicit scope, and verification, grouped
public/private/maintenance boundaries, and a contained quote panel.

#### Scenario: A prospective sponsor views the page

- **WHEN** the route is rendered
- **THEN** the installation-versus-migration comparison has two distinct panels
- **AND** the sponsorship benefits appear as three distinct cards
- **AND** the final quote panel preserves the existing structured mailto intake

### Requirement: Commercial restyling does not change commercial behaviour

The restyling SHALL NOT change support-tier availability, Paddle checkout
behaviour, mailto recipients or fields, supporter data sourcing, public prices,
or backend data collection.

#### Scenario: An existing commercial action is selected

- **WHEN** a visitor selects a configured support tier, custom project sponsor,
  or integration quote call to action
- **THEN** it uses the existing checkout or mailto path unchanged
