import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Endstate — Save your machine. Set up the next one.",
  description:
    "Endstate captures every app and setting on your Windows machine, then restores them on a fresh install. One scan. One file. Done.",
  openGraph: {
    title: "Endstate — Save your machine. Set up the next one.",
    description:
      "Declarative Windows machine provisioning. Capture every app and setting, restore on any machine.",
    url: "https://substratesystems.io/endstate",
    siteName: "Substrate Systems",
    type: "website",
    images: [
      {
        url: "/endstate/01-landing.png",
        width: 1400,
        height: 900,
        alt: "Endstate application",
      },
    ],
  },
  icons: {
    icon: "/endstate/icons/dark-full/dark-sw4.svg",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Endstate",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Windows",
  description:
    "Declarative Windows machine provisioning — captures installed apps and settings, saves to a portable file, restores on a fresh install.",
  url: "https://substratesystems.io/endstate",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "EUR",
    availability: "https://schema.org/InStock",
  },
  author: {
    "@type": "Organization",
    name: "Substrate Systems",
    url: "https://substratesystems.io",
  },
  license: "https://substratesystems.io/terms",
  codeRepository: "https://github.com/Artexis10/endstate",
  softwareVersion: "1.0",
};

export default function EndstateLayout({ children }: { children: React.ReactNode }) {
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
