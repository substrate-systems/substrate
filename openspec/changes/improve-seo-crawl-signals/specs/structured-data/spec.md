## ADDED Requirements

### Requirement: Structured data matches the canonical page

Product and FAQ structured data SHALL be emitted only on the canonical page
where the described product and answers are visibly present. A shared layout
MUST NOT inject that data into child pages that do not display it.

#### Scenario: Endstate index page

- **WHEN** `/endstate` is rendered
- **THEN** its SoftwareApplication and FAQ structured data describe visible
  product and FAQ content on that page

#### Scenario: Endstate child page

- **WHEN** an Endstate child route such as `/endstate/account` is rendered
- **THEN** it does not inherit the Endstate index page's SoftwareApplication or
  FAQ structured data from the shared layout

#### Scenario: Exomem FAQ data

- **WHEN** `/exomem` renders five visible FAQ entries
- **THEN** its FAQ structured data contains exactly those same five questions
  and answers
