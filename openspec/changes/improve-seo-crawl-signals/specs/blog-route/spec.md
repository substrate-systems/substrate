## ADDED Requirements

### Requirement: Honest blog modification signals

The system SHALL support an optional `updated` frontmatter date for meaningful
public changes while retaining `published` as the original publication date.
When `updated` exists, the blog sitemap `lastmod`, Article `dateModified`, and
OpenGraph modification time SHALL use it. When it does not exist, sitemap
`lastmod` SHALL fall back to `published` and Article `dateModified` SHALL be
omitted.

#### Scenario: Meaningfully updated article

- **WHEN** a published article has `published: 2026-05-24` and `updated: 2026-07-22`
- **THEN** its visible publication date and Article `datePublished` remain `2026-05-24`
- **AND** its sitemap `lastmod`, Article `dateModified`, and OpenGraph modification time use `2026-07-22`

#### Scenario: Unchanged article

- **WHEN** a published article does not have `updated` frontmatter
- **THEN** its sitemap `lastmod` uses `published`
- **AND** its Article JSON-LD does not invent a `dateModified` value

### Requirement: Consolidated blog route redirect

The system SHALL permanently redirect
`/blog/set-up-new-windows-pc-fast` to
`/blog/new-windows-pc-setup-guide`. The source URL MUST NOT appear in the blog
index, feed, sitemap, or article-list structured data. Other build-known posts
and unknown-slug 404 behavior SHALL remain unchanged.

#### Scenario: Consolidated article is requested

- **WHEN** an HTTP GET request is made to `/blog/set-up-new-windows-pc-fast`
- **THEN** the response is a permanent redirect to `/blog/new-windows-pc-setup-guide`

#### Scenario: Discovery surfaces are generated

- **WHEN** the blog index, feed, sitemap, and article-list structured data are generated
- **THEN** they include the canonical guide where applicable
- **AND** they do not include `/blog/set-up-new-windows-pc-fast`

## MODIFIED Requirements

### Requirement: Unknown slug returns 404

The system SHALL respond with HTTP 404 for any `/blog/<slug>` whose
`content/blog/<slug>.md` file does not exist and which is not a configured
consolidation redirect. The set of valid slugs and redirects is fixed at build
time.

#### Scenario: Nonexistent post

- **WHEN** an HTTP GET request is made to `/blog/does-not-exist`, no matching
  markdown file exists, and no redirect is configured
- **THEN** the system responds with HTTP 404
