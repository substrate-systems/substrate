import { breadcrumbJsonLd, buildMetadata, siteConfig } from "@/lib/seo";
import { PERSON } from "@/lib/structured-data";

export const metadata = buildMetadata({
  title: "Q — source-grounded AI for content libraries",
  description:
    "Q turns a creator or company's own content library — video, audio, documents — into a branded AI knowledge base whose answers cite the exact source they came from. Built by Substrate Systems.",
  path: "/q",
  ogImage: `/api/og?title=${encodeURIComponent("Q")}`,
});

const breadcrumb = breadcrumbJsonLd([
  { name: "Home", path: "/" },
  { name: "Q", path: "/q" },
]);

// Entity node for Q. The canonical product site is useq.ai; this page exists so that
// Substrate's own domain can resolve the Substrate → Q relationship for search and
// answer engines. No Offer is emitted: Q has no public pricing, and asserting one
// would be false.
const softwareApplication = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Q",
  alternateName: "Q by Substrate Systems",
  url: "https://useq.ai",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Web browser",
  description:
    "Multi-tenant, source-grounded AI platform. Ingests a creator or company's content library and answers questions with citations back to the original source, on the customer's own domain and branding.",
  provider: {
    "@type": "Organization",
    name: siteConfig.name,
    legalName: "Substrate Systems OÜ",
    url: siteConfig.url,
  },
  author: PERSON,
};

export default function QLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplication) }}
      />
      {children}
    </>
  );
}
