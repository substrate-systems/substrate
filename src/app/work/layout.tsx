import { buildMetadata } from "@/lib/seo";
import { personJsonLd } from "@/lib/structured-data";

export const metadata = buildMetadata({
  title: "Hugo Ander Kivi — LLM governance & systems engineering",
  description:
    "Hugo Ander Kivi: contract-based LLM governance for AI-augmented teams, plus the systems behind Q, Endstate, and Exomem. Selected work and writing.",
  path: "/work",
  ogImage: `/api/og?title=${encodeURIComponent("Hugo Ander Kivi")}`,
  ogType: "profile",
});

export default function WorkLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd()) }}
      />
      {children}
    </>
  );
}
