## Why

Google Search Console discovered most of the site but had not crawled fifteen
canonical pages as of 2026-07-10. The live pages are indexable, but several
signals make the crawl set noisier or less trustworthy than it needs to be:

- blog sitemap dates describe the original article date even after meaningful
  publication or editorial changes;
- an overlapping Windows setup article competes with the stronger guide;
- product and FAQ structured data appears on routes where the described
  content is not visible;
- the Windows migration articles do not consistently reinforce their canonical
  guide.

## What Changes

- Add an optional blog `updated` date and use it for sitemap `lastmod`, Article
  `dateModified`, and OpenGraph modification metadata while preserving the
  original publication date.
- Permanently redirect `/blog/set-up-new-windows-pc-fast` to
  `/blog/new-windows-pc-setup-guide`, and exclude the retired URL from the blog
  index, feed, sitemap, and structured-data article list.
- Expand the canonical Windows setup guide, reduce duplicated Store-app advice
  in its Winget spoke, and add contextual spoke-to-guide links.
- Scope Endstate product/FAQ structured data to the page where that content is
  visible, and make Exomem FAQ structured data match its five visible FAQs.

## Capabilities

### Modified Capabilities

- `blog-route`: supports honest modification dates and a deliberate permanent
  redirect for a consolidated article.

### New Capabilities

- `structured-data`: requires structured data to describe content visible on
  the same canonical page.

## Impact

- Blog parsing, metadata, sitemap generation, feed/index selection, and one
  route redirect change.
- Five Windows migration articles receive editorial or internal-link updates.
- Endstate and Exomem structured-data placement changes without changing their
  visible product UI.
- No database, billing, runtime dependency, or external service changes.
