import { breadcrumbJsonLd, buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Endstate Supporters — who funds free, open setup",
  description:
    "The people who bought a Supporter License so Endstate stays free, open source, and telemetry-free for everyone. Thank you.",
  path: "/endstate/supporters",
  ogImage: `/api/og?title=${encodeURIComponent("Supporters")}`,
});

const breadcrumb = breadcrumbJsonLd([
  { name: "Home", path: "/" },
  { name: "Endstate", path: "/endstate" },
  { name: "Supporters", path: "/endstate/supporters" },
]);

export default function SupportersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
