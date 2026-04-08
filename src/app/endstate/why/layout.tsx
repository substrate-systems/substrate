import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Why I Built Endstate — Endstate",
  description:
    "Every time I set up a fresh Windows machine, the same ritual begins. Open a browser. Search for the apps I need. Download them one by one. Install them. Then the worse part — realize my settings are gone.",
  openGraph: {
    title: "Why I Built Endstate — Endstate",
    description:
      "Every time I set up a fresh Windows machine, the same ritual begins. Open a browser. Search for the apps I need. Download them one by one.",
    url: "https://substratesystems.io/endstate/why",
    siteName: "Substrate Systems",
    type: "article",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Why I Built Endstate",
  author: {
    "@type": "Person",
    name: "Hugo Ander Kivi",
  },
  publisher: {
    "@type": "Organization",
    name: "Substrate Systems",
  },
  datePublished: "2026-04",
  url: "https://substratesystems.io/endstate/why",
};

export default function WhyLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {children}
    </>
  );
}
