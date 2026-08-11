import { breadcrumbJsonLd, buildMetadata } from "@/lib/seo";

const TITLE = "Sponsor an Endstate integration";
const DESCRIPTION =
  "Fund deeper migration support for a specific Windows application: settings capture and restore, version handling, package-identity edge cases, testing, and documentation. Request a quote.";

export const metadata = buildMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/endstate/sponsor-an-integration",
  ogImage: `/api/og?title=${encodeURIComponent("Sponsor an integration")}`,
});

const breadcrumb = breadcrumbJsonLd([
  { name: "Home", path: "/" },
  { name: "Endstate", path: "/endstate" },
  { name: "Sponsor an integration", path: "/endstate/sponsor-an-integration" },
]);

export default function SponsorAnIntegrationLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      {children}
    </>
  );
}
