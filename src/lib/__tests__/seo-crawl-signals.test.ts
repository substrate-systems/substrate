import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import sitemap from "../../app/sitemap";
import { articleJsonLd } from "../structured-data";
import { getAllPostsMeta, getPostSlugs, getPublishedPostsMeta } from "../blog";
import { buildMetadata } from "../seo";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("SEO crawl signals", () => {
  it("preserves published dates while exposing meaningful article updates", () => {
    const posts = getAllPostsMeta();
    const expectedUpdates = {
      "lazy-loading-vs-instruction-following": "2026-07-04",
      "coolify-to-k3s": "2026-07-20",
      "we-cannot-decrypt-your-data": "2026-07-20",
      "new-windows-pc-setup-guide": "2026-07-22",
      "reinstall-all-apps-with-winget": "2026-07-22",
    };

    for (const [slug, updated] of Object.entries(expectedUpdates)) {
      assert.equal(posts.find((post) => post.slug === slug)?.updated, updated);
    }
    assert.equal(
      posts.find((post) => post.slug === "governance-as-compression")?.updated,
      undefined
    );
  });

  it("uses updated dates in the sitemap and filters consolidated URLs from public discovery", () => {
    const entries = sitemap();
    const updatedEntry = entries.find(
      (entry) => entry.url === "https://substratesystems.io/blog/new-windows-pc-setup-guide"
    );

    assert.ok(updatedEntry?.lastModified instanceof Date);
    assert.equal(updatedEntry.lastModified.toISOString().slice(0, 10), "2026-07-22");
    assert.equal(
      entries.some((entry) => entry.url.endsWith("/blog/set-up-new-windows-pc-fast")),
      false
    );
    assert.equal(
      getPublishedPostsMeta().some((post) => post.slug === "set-up-new-windows-pc-fast"),
      false
    );
    assert.equal(getPostSlugs().includes("set-up-new-windows-pc-fast"), true);
  });

  it("adds modification metadata only for updated articles", () => {
    const updatedArticle = articleJsonLd({
      title: "Updated article",
      description: "A description.",
      slug: "updated-article",
      published: "2026-05-24",
      updated: "2026-07-22",
    });
    const unchangedArticle = articleJsonLd({
      title: "Unchanged article",
      description: "A description.",
      slug: "unchanged-article",
      published: "2026-05-24",
    });
    const updatedMetadata = buildMetadata({
      title: "Updated article",
      description: "A description.",
      path: "/blog/updated-article",
      ogType: "article",
      publishedTime: "2026-05-24",
      modifiedTime: "2026-07-22",
    });
    const unchangedMetadata = buildMetadata({
      title: "Unchanged article",
      description: "A description.",
      path: "/blog/unchanged-article",
      ogType: "article",
      publishedTime: "2026-05-24",
    });

    assert.equal(updatedArticle.datePublished, "2026-05-24");
    assert.equal(updatedArticle.dateModified, "2026-07-22");
    assert.equal(unchangedArticle.dateModified, undefined);
    const updatedOpenGraph = updatedMetadata.openGraph;
    const unchangedOpenGraph = unchangedMetadata.openGraph;
    assert.ok(
      updatedOpenGraph && "type" in updatedOpenGraph && updatedOpenGraph.type === "article"
    );
    assert.ok(
      unchangedOpenGraph && "type" in unchangedOpenGraph && unchangedOpenGraph.type === "article"
    );
    assert.equal(updatedOpenGraph.modifiedTime, "2026-07-22");
    assert.equal(unchangedOpenGraph.modifiedTime, undefined);
  });

  it("keeps the redirect and structured data scoped to their canonical pages", () => {
    const blogRoute = source("src/app/blog/[slug]/page.tsx");
    const endstateLayout = source("src/app/endstate/layout.tsx");
    const endstatePage = source("src/app/endstate/page.tsx");
    const exomemPage = source("src/app/exomem/page.tsx");

    assert.match(blogRoute, /getBlogRedirect\(slug\)/);
    assert.match(blogRoute, /permanentRedirect\(redirectTo\)/);
    assert.doesNotMatch(endstateLayout, /SoftwareApplication|FAQPage/);
    assert.match(endstatePage, /SoftwareApplication/);
    assert.match(endstatePage, /FAQPage/);
    assert.match(exomemPage, /mainEntity: displayFaqs\.map/);
    assert.doesNotMatch(exomemPage, /mainEntity: faqs\.map/);
  });

  it("makes the Windows setup guide the useful cluster hub", () => {
    const guide = source("content/blog/new-windows-pc-setup-guide.md");
    const winget = source("content/blog/reinstall-all-apps-with-winget.md");
    const store = source("content/blog/winget-export-microsoft-store-apps.md");
    const sharing = source("content/blog/share-your-app-setup.md");
    const alternative = source("content/blog/free-open-source-pc-migration-alternative.md");

    assert.match(guide, /winget export -o apps\.json/);
    assert.match(
      guide,
      /winget import -i apps\.json --accept-package-agreements --accept-source-agreements/
    );
    assert.match(guide, /USB stick|USB drive/);
    assert.doesNotMatch(guide, /\/blog\/set-up-new-windows-pc-fast/);
    assert.match(winget, /\/blog\/new-windows-pc-setup-guide/);
    assert.match(winget, /\/blog\/winget-export-microsoft-store-apps/);
    for (const post of [store, sharing, alternative]) {
      assert.match(post, /\/blog\/new-windows-pc-setup-guide/);
    }
  });
});
