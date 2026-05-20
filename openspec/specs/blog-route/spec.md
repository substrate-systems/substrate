# blog-route Specification

## Purpose
TBD - created by archiving change substrate-blog-route. Update Purpose after archive.
## Requirements
### Requirement: Blog post route path

The system SHALL serve the rendered contents of `content/blog/<slug>.md` at the URL path `/blog/<slug>` via an HTTP GET request, where `<slug>` equals the markdown filename without its `.md` extension.

#### Scenario: Existing post renders

- **WHEN** an HTTP GET request is made to `/blog/governance-as-compression` and `content/blog/governance-as-compression.md` exists
- **THEN** the system responds with HTTP 200 and an HTML document rendered from that markdown file

#### Scenario: Slug maps to filename

- **WHEN** a markdown file `content/blog/<name>.md` is present at build time
- **THEN** the route `/blog/<name>` is generated for it and no other path serves that file

### Requirement: Unknown slug returns 404

The system SHALL respond with HTTP 404 for any `/blog/<slug>` whose `content/blog/<slug>.md` file does not exist. The set of valid slugs is fixed at build time.

#### Scenario: Nonexistent post

- **WHEN** an HTTP GET request is made to `/blog/does-not-exist` and no matching markdown file exists
- **THEN** the system responds with HTTP 404

### Requirement: Frontmatter drives title and metadata

The system SHALL render the post's frontmatter `title` as the page `<h1>` and as the HTML document title, and SHALL render the `published` date visibly on the page. The post `description` SHALL populate the meta description and OpenGraph description.

#### Scenario: Title and date render

- **WHEN** a post with frontmatter `title` and `published` is requested
- **THEN** the rendered page contains an `<h1>` equal to the `title`, the document `<title>` includes the `title`, and the `published` date is visible in the page body

### Requirement: Code blocks and heading anchors

The system SHALL render fenced code blocks with syntax highlighting and SHALL assign `id` anchors to headings in the rendered body.

#### Scenario: Fenced code is highlighted

- **WHEN** a post body contains a fenced code block
- **THEN** the rendered HTML for that block contains syntax-highlighting markup (token-level styling), not a plain unstyled `<pre>` text node

#### Scenario: Headings are anchored

- **WHEN** a post body contains a level-2 or level-3 heading
- **THEN** the rendered heading element has an `id` attribute derived from its text

### Requirement: Static generation, no runtime parsing

The system SHALL generate blog post pages at build time and MUST NOT parse markdown per request. Markdown files are read from `content/blog/` during the build only.

#### Scenario: Pages are prerendered

- **WHEN** the application is built
- **THEN** each `/blog/<slug>` page is statically prerendered and serving it requires no runtime markdown parsing

### Requirement: First-party content trust boundary

The markdown-to-HTML pipeline MUST disable raw-HTML passthrough so that HTML embedded in a markdown source is not emitted into the page. Content under `content/blog/` is treated as first-party only.

#### Scenario: Raw HTML in source is not passed through

- **WHEN** a markdown source contains a raw HTML element such as a `<script>` tag
- **THEN** the rendered output does not include that raw HTML element as live markup

