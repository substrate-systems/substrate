import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import sitemap from "../../app/sitemap";
import { GET as getRssFeed } from "../../app/feed.xml/route";
import { articleJsonLd, howToJsonLd } from "../structured-data";
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

  it("makes Endstate Cloud's bounded backup scope explicit", () => {
    const scopeDisclaimer =
      "Endstate Cloud protects the application list and supported non-secret settings captured by Endstate; it is not personal-file backup.";

    for (const path of ["src/app/endstate/page.tsx", "public/llms.txt", "public/llms-full.txt"]) {
      assert.ok(
        source(path).includes(scopeDisclaimer),
        `${path} must contain the Cloud scope disclaimer`
      );
    }
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

  it("publishes a distinct reinstall-restoration guide with the required internal links", async () => {
    const slug = "restore-windows-apps-and-settings-after-reinstall";
    const post = getPublishedPostsMeta().find((candidate) => candidate.slug === slug);

    assert.ok(post, "the restore guide must be published for blog, RSS, and sitemap discovery");
    assert.equal(post.title, "How to Restore Windows Apps and Settings After Reinstalling Windows");
    assert.match(post.description, /restore Windows apps and settings/i);
    assert.equal(
      sitemap().some((entry) => entry.url === `https://substratesystems.io/blog/${slug}`),
      true
    );
    const howto = howToJsonLd(slug);
    assert.equal(howto?.["@type"], "HowTo");
    assert.equal(howto?.step.length, 5);
    const rss = await getRssFeed();
    const rssXml = await rss.text();
    assert.match(rssXml, new RegExp(`https://substratesystems\\.io/blog/${slug}`));
    assert.match(rssXml, /How to Restore Windows Apps and Settings After Reinstalling Windows/);

    const restoreGuide = source(`content/blog/${slug}.md`);
    assert.match(restoreGuide, /\/endstate\)/);
    assert.match(restoreGuide, /\/endstate\/apps\)/);
    assert.match(restoreGuide, /\/blog\/new-windows-pc-setup-guide\)/);
    assert.match(restoreGuide, /\/blog\/reinstall-all-apps-with-winget\)/);
    assert.match(restoreGuide, /must be captured\s+\*\*before\*\*\s+reinstalling/i);
    assert.match(restoreGuide, /package-manager driver and package reference/i);
    assert.match(restoreGuide, /package managers or package sources are unavailable/i);

    const pillar = source("content/blog/new-windows-pc-setup-guide.md");
    const winget = source("content/blog/reinstall-all-apps-with-winget.md");
    const endstate = source("src/app/endstate/page.tsx");
    const llms = source("public/llms-full.txt");
    assert.match(pillar, new RegExp(`/blog/${slug}`));
    assert.match(winget, new RegExp(`/blog/${slug}`));
    assert.match(endstate, new RegExp(`/blog/${slug}`));
    assert.match(llms, new RegExp(`https://substratesystems\\.io/blog/${slug}`));
  });

  // Regression guard for a live defect: /exomem/{setup,support,privacy,terms} declared
  // raw `Metadata` with only title+description, so they inherited the root layout's
  // `alternates: { canonical: "/" }` and shipped pointing at the homepage — four
  // indexable, sitemap-listed pages disowning themselves.
  //
  // Asserting `buildMetadata` in isolation would not have caught this, exactly as the
  // Article-image bug passed a builder test while every call site stayed broken. So
  // this walks the sitemap and checks the call sites instead.
  it("gives every sitemap route a self-referencing canonical, not the inherited root one", () => {
    const routes = sitemap()
      .map((entry) => entry.url.replace("https://substratesystems.io", ""))
      // Blog posts resolve through blog/[slug]/generateMetadata, which is asserted above.
      .filter((path) => !/^\/blog\/.+/.test(path));

    assert.ok(routes.length >= 15, "expected the static route set, got " + routes.length);

    // The homepage legitimately carries its canonical on the root layout.
    assert.match(source("src/app/layout.tsx"), /alternates:\s*\{\s*canonical:\s*"\/"/);

    for (const path of routes) {
      if (path === "") continue;

      const candidates = [`src/app${path}/page.tsx`, `src/app${path}/layout.tsx`].filter((file) =>
        existsSync(resolve(process.cwd(), file))
      );
      assert.ok(candidates.length > 0, `${path} is in the sitemap but has no page or layout`);

      const declaresOwnPath = candidates.some((file) =>
        source(file).includes(`path: "${path}"`)
      );
      assert.ok(
        declaresOwnPath,
        `${path} is in the sitemap but no page/layout passes path: "${path}" to buildMetadata — ` +
          "it will inherit the root canonical and point at the homepage"
      );
    }
  });

  it("keeps Q reachable from the site's internal graph rather than only useq.ai", () => {
    assert.equal(
      sitemap().some((entry) => entry.url === "https://substratesystems.io/q"),
      true
    );
    // Publishing a page without inbound links is not shipping it.
    assert.match(source("src/components/Products.tsx"), /href: "\/q"/);
    assert.match(source("src/components/Footer.tsx"), /href: "\/q"/);
    assert.match(source("public/llms.txt"), /https:\/\/substratesystems\.io\/q\)/);

    // Q is the only closed-source product and has no public pricing; the entity page
    // must not imply self-serve purchase.
    const qPage = source("src/app/q/page.tsx");
    assert.match(qPage, /Proprietary/);
    assert.match(qPage, /no public signup|no self-serve|operator-led/i);
    assert.match(qPage, /hello@useq\.ai/);
  });
});
