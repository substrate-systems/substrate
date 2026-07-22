## Context

The sitemap is generated at build time from static routes plus published blog
frontmatter. Google had successfully read it, but Search Console showed a batch
of URLs as discovered and never crawled. The corrective work should concentrate
authority and make machine-readable signals accurate; it cannot guarantee that
Google will crawl or index a page.

## Decisions

### Preserve publication dates and add explicit modification dates

`published` remains the visible and canonical publication date. Authors may add
`updated` only for meaningful public changes. Sitemap `lastmod`, OpenGraph
`modifiedTime`, and Article `dateModified` use `updated`; sitemap falls back to
`published` for unchanged articles.

This avoids build-time timestamps and does not mark navigation-only or trivial
formatting changes as editorial updates.

### Consolidate the overlapping fast-setup article

The short `set-up-new-windows-pc-fast` article overlaps the broader
`new-windows-pc-setup-guide`. Its unique offline-copy advice moves into the
guide. The old route remains build-known so it can issue a permanent redirect,
but it is removed from every discovery surface.

A central redirect map is the source of truth for discovery filtering and route
behavior. Unknown blog slugs continue to return 404.

### Scope structured data to visible content

Endstate SoftwareApplication and FAQ JSON-LD moves from the shared layout to
the Endstate index page. Child routes retain the shared metadata but do not
claim product FAQs they do not show. Exomem FAQ JSON-LD uses exactly the same
five questions rendered on the page.

### Strengthen the Windows setup cluster

The complete setup guide becomes the cluster hub. The surviving Winget,
sharing, and free-alternative articles link to it contextually. The focused
reinstall article keeps its distinct command workflow and points to the
separate Microsoft Store gap article rather than repeating that explanation.

## Non-goals

- Claiming that the change forces Google indexing.
- Redirecting the HTTP origin; its HTTP-to-HTTPS redirect is intentional.
- Adding Indexing API misuse, synthetic backlinks, or site-wide design work.
- Using Fable without a separate conversion or design problem to solve.

## Verification

- Unit/contract tests for redirect discovery filtering, sitemap dates, Article
  modification data, schema placement, and content-cluster links.
- Full test, lint, build, and strict OpenSpec validation.
- Built-server request confirms the consolidated URL returns a permanent
  redirect to the canonical guide.
