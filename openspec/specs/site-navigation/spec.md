# site-navigation Specification

## Purpose
TBD - created by archiving change substrate-site-navigation. Update Purpose after archive.
## Requirements
### Requirement: Global footer navigation

The global site `Footer` SHALL render navigation links to Work (`/work`), Writing (`/blog`), and Endstate (`/endstate`), and SHALL link its wordmark to the home page (`/`). Because the `Footer` renders on the homepage, the work page, and blog articles, these links SHALL be present on each of those surfaces.

#### Scenario: Footer links present on the homepage

- **WHEN** the homepage `/` is rendered
- **THEN** the footer contains links with hrefs `/work`, `/blog`, and `/endstate`

#### Scenario: Articles link back into the graph

- **WHEN** a blog article page is rendered
- **THEN** its footer contains links with hrefs `/work`, `/blog`, and `/endstate`

#### Scenario: Wordmark links home

- **WHEN** the footer is rendered on any page
- **THEN** the footer wordmark is a link whose href is `/`

### Requirement: Blog index

The system SHALL serve a static page at `/blog` that lists published articles, each showing its title (linking to the article), its one-line description, and its published date, ordered newest first.

#### Scenario: Index lists the article

- **WHEN** an HTTP GET request is made to `/blog`
- **THEN** the system responds with HTTP 200 and the page contains a link to `/blog/governance-as-compression` with that article's title and published date

#### Scenario: Index is statically generated

- **WHEN** the application is built
- **THEN** `/blog` is statically prerendered with no per-request data fetching

### Requirement: Navigable graph

Every primary public surface SHALL be reachable from every other via in-page links (not only via `sitemap.xml`).

#### Scenario: Home reaches the proof surfaces

- **WHEN** a visitor is on the homepage
- **THEN** they can navigate to `/work` and `/blog` through footer links without knowing a direct URL

