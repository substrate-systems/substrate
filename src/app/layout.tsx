import type { Metadata } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { siteConfig } from "@/lib/seo";
import { PostHogProvider } from "./providers";
import { PrivacySafeAnalytics } from "./privacy-safe-analytics";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

// Exomem's mono-forward identity (see .brand-exomem in globals.css). Deliberately
// IBM Plex Mono — distinct from Endstate's JetBrains Mono. Only /exomem consumes it.
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
});

const description = siteConfig.defaultDescription;

export const metadata: Metadata = {
  title: {
    template: `%s ${siteConfig.titleSuffix}`,
    default: siteConfig.defaultTitle,
  },
  description,
  metadataBase: new URL(siteConfig.url),
  alternates: { canonical: "/" },
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon-16x16.png",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: siteConfig.defaultTitle,
    description,
    url: siteConfig.url,
    siteName: siteConfig.name,
    locale: siteConfig.locale,
    type: "website",
    images: [
      {
        url: siteConfig.defaultOgImage,
        width: 1200,
        height: 630,
        alt: siteConfig.defaultTitle,
      },
    ],
  },
  twitter: {
    card: siteConfig.twitterCard,
    title: siteConfig.defaultTitle,
    description,
    images: [siteConfig.defaultOgImage],
  },
  robots: {
    index: true,
    follow: true,
  },
  other: {
    "asset:hero-image": "Photo by Adrien Olichon",
    "asset:hero-image-url": "https://www.pexels.com/@adrien-olichon-1257089/",
    "asset:hero-image-license": "Pexels License (free for commercial use, no attribution required)",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "Substrate Systems",
              legalName: "Substrate Systems OÜ",
              url: "https://substratesystems.io",
              logo: "https://substratesystems.io/brand/logos/substrate-logo-dark.png",
              founder: {
                "@type": "Person",
                name: "Hugo Ander Kivi",
              },
              foundingLocation: {
                "@type": "Place",
                name: "Estonia",
              },
              description: "Software infrastructure for durable systems.",
              sameAs: [
                "https://github.com/Artexis10",
                "https://www.linkedin.com/company/substratesystems/",
              ],
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: siteConfig.name,
              url: siteConfig.url,
              publisher: {
                "@type": "Organization",
                name: siteConfig.name,
              },
            }),
          }}
        />
      </head>
      <body className={`${inter.variable} ${plexMono.variable} antialiased`}>
        <PostHogProvider>{children}</PostHogProvider>
        <PrivacySafeAnalytics />
      </body>
    </html>
  );
}
