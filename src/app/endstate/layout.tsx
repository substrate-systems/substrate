import { buildMetadata, siteConfig } from "@/lib/seo";
import { faqs } from "./faq-data";

const DESCRIPTION =
  "Endstate scans your Windows PC, saves your apps and settings to one portable file, and reinstalls everything on a fresh machine in minutes. Free, open-source, local-first — no account.";

export const metadata = {
  ...buildMetadata({
    title: "Endstate — Set Up a New Windows PC & Restore Your Apps in Minutes",
    description: DESCRIPTION,
    path: "/endstate",
    ogImage: "/endstate/og",
    standaloneTitle: true,
  }),
  // Endstate subtree uses its own mark as the favicon.
  icons: { icon: "/endstate/icons/dark-full/dark-sw4.svg" },
};

const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Endstate",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Windows",
  description:
    "Reinstall your apps and restore your settings on a new Windows PC. Scan your current machine, save a portable setup file, then restore everything on a fresh install in minutes.",
  url: `${siteConfig.url}/endstate`,
  downloadUrl: `${siteConfig.url}/download`,
  installUrl: `${siteConfig.url}/download`,
  screenshot: [
    `${siteConfig.url}/endstate/01-landing.png`,
    `${siteConfig.url}/endstate/02-save-results.png`,
    `${siteConfig.url}/endstate/03-setup-results.png`,
  ],
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "EUR",
    availability: "https://schema.org/InStock",
  },
  author: {
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
  },
  license: `${siteConfig.url}/terms`,
  codeRepository: "https://github.com/Artexis10/endstate",
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: typeof faq.a === "string" ? faq.a : (faq.aText ?? ""),
    },
  })),
};

export default function EndstateLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {children}
    </>
  );
}
