# work-page Specification

## Purpose
TBD - created by archiving change substrate-work-page. Update Purpose after archive.
## Requirements
### Requirement: Work page route

The system SHALL serve a static page at the URL path `/work` via an HTTP GET request, rendered under the site's shared brand chrome (header and `Footer`, dark theme).

#### Scenario: Page renders

- **WHEN** an HTTP GET request is made to `/work`
- **THEN** the system responds with HTTP 200 and an HTML document containing the heading text "Hugo Ander Kivi"

#### Scenario: Statically generated

- **WHEN** the application is built
- **THEN** `/work` is statically prerendered and serving it requires no per-request data fetching

### Requirement: Featured proof surfaces

The page SHALL link to the governance article and SHALL present the Endstate and Q work items with their canonical destinations.

#### Scenario: Article is linked

- **WHEN** the page is rendered
- **THEN** it contains a hyperlink whose href is `/blog/governance-as-compression`

#### Scenario: Work items are linked

- **WHEN** the page is rendered
- **THEN** it contains a link to `https://github.com/Artexis10/endstate` (Endstate) and a link to `https://useq.ai` (Q)

### Requirement: Always-present contact links

The page SHALL always render a GitHub profile link (`https://github.com/Artexis10`) and an email link (`mailto:founder@substratesystems.io`).

#### Scenario: GitHub and email present

- **WHEN** the page is rendered
- **THEN** it contains a link to `https://github.com/Artexis10` and a `mailto:founder@substratesystems.io` link

### Requirement: Availability-gated CV and LinkedIn links

The CV-download link SHALL render only when the CV PDF exists at `public/downloads/hugo-ander-kivi-cv.pdf`. The LinkedIn link SHALL render only when a non-empty LinkedIn URL is configured. Neither absence produces a broken link.

#### Scenario: CV link omitted when no PDF

- **WHEN** the page is rendered and no `public/downloads/hugo-ander-kivi-cv.pdf` file exists
- **THEN** the page contains no "Download CV" link and no link to `/downloads/hugo-ander-kivi-cv.pdf`

#### Scenario: CV link present when PDF exists

- **WHEN** the page is rendered and `public/downloads/hugo-ander-kivi-cv.pdf` exists
- **THEN** the page contains a link whose href is `/downloads/hugo-ander-kivi-cv.pdf`

#### Scenario: LinkedIn link omitted when unconfigured

- **WHEN** the page is rendered and the LinkedIn URL is empty
- **THEN** the page contains no LinkedIn link

### Requirement: Public-page redaction

The page copy MUST NOT contain employer-identifying names or iGaming-domain vocabulary. Scale claims are expressed in domain-neutral terms.

#### Scenario: No domain-leaking terms

- **WHEN** the rendered page source is inspected
- **THEN** it contains none of the terms "Hub88", "Yolo", "betting", "bets", "iGaming", or "gambling" (case-insensitive)

### Requirement: Token-only styling

The page MUST style itself using the existing design-system tokens and MUST NOT introduce new color or spacing tokens or hardcoded palette values.

#### Scenario: No palette leak

- **WHEN** the route source under `src/app/work` is inspected
- **THEN** it references design-system token utilities/variables only, with no hardcoded hex color values

