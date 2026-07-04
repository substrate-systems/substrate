import { breadcrumbJsonLd, buildMetadata, siteConfig } from "@/lib/seo";

const ARTICLE_TITLE = "Why I Built Endstate";

export const metadata = buildMetadata({
  title: "Why I Built Endstate — the new-PC setup problem",
  description:
    "Every fresh Windows machine means the same ritual: hunt for apps, install one by one, lose your settings. Why I built Endstate to end it.",
  path: "/endstate/why",
  ogImage: `/api/og?title=${encodeURIComponent(ARTICLE_TITLE)}`,
  ogType: "article",
  authors: ["Hugo Ander Kivi"],
  publishedTime: "2026-04-01",
});

const articleJsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: ARTICLE_TITLE,
  author: {
    "@type": "Person",
    name: "Hugo Ander Kivi",
  },
  publisher: {
    "@type": "Organization",
    name: siteConfig.name,
  },
  datePublished: "2026-04-01",
  url: `${siteConfig.url}/endstate/why`,
};

const breadcrumb = breadcrumbJsonLd([
  { name: "Home", path: "/" },
  { name: "Endstate", path: "/endstate" },
  { name: ARTICLE_TITLE, path: "/endstate/why" },
]);

export default function WhyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      {children}
    </>
  );
}
