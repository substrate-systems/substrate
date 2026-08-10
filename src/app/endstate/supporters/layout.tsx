import { breadcrumbJsonLd, buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Support Endstate — the people who fund free, open setup",
  description:
    "The people who chose to support Endstate so it stays free, open source, and telemetry-free for everyone — and how to contribute. Supporting unlocks nothing; the product is already complete.",
  path: "/endstate/supporters",
  ogImage: `/api/og?title=${encodeURIComponent("Supporters")}`,
});

const breadcrumb = breadcrumbJsonLd([
  { name: "Home", path: "/" },
  { name: "Endstate", path: "/endstate" },
  { name: "Supporters", path: "/endstate/supporters" },
]);

export default function SupportersLayout({ children }: { children: React.ReactNode }) {
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
