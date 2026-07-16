## MODIFIED Requirements

### Requirement: Global footer navigation

The global site `Footer` SHALL render navigation links to Work (`/work`), Writing (`/blog`), Photography (`/photography`), and Endstate (`/endstate`), and SHALL link its wordmark to the home page (`/`). Because the `Footer` renders on the homepage, the work page, blog articles, and photography pages, these links SHALL be present on each of those surfaces.

#### Scenario: Footer links present on the homepage

- **WHEN** the homepage `/` is rendered
- **THEN** the footer contains links with hrefs `/work`, `/blog`, `/photography`, and `/endstate`

#### Scenario: Photography remains quietly discoverable

- **WHEN** a visitor is on `/work`
- **THEN** they can navigate to `/photography` through the “Elsewhere” links
- **AND** Photography is not presented as a product in the selected-work section

#### Scenario: Articles link back into the graph

- **WHEN** a blog article page is rendered
- **THEN** its footer contains links with hrefs `/work`, `/blog`, `/photography`, and `/endstate`

#### Scenario: Wordmark links home

- **WHEN** the footer is rendered on any page
- **THEN** the footer wordmark is a link whose href is `/`
