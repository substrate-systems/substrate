import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Endstate — machine provisioning and backup",
  description:
    "Local-first machine setup and restore. Windows-first today, with Linux/macOS support through the cross-platform engine and Nix path.",
  openGraph: {
    title: "Endstate — machine provisioning and backup",
    description:
      "Local-first machine setup and restore, with optional hosted backup the server cannot decrypt.",
    url: "https://substratesystems.io/endstate",
    siteName: "Substrate Systems",
    type: "website",
    images: [
      {
        url: "/endstate/og",
        width: 1200,
        height: 630,
        alt: "Endstate — machine provisioning and backup",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Endstate — machine provisioning and backup",
    description:
      "Local-first machine setup and restore. Windows-first today, with Linux/macOS support in validation.",
    images: ["/endstate/og"],
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
    "Local-first machine provisioning and backup. Windows-first today, with Linux and macOS support moving through validation.",
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
