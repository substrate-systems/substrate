import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Analytics } from "@vercel/analytics/react";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Substrate — Foundational Systems",
  description: "Software infrastructure for durable systems.",
  metadataBase: new URL("https://substratesystems.io"),
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon-16x16.png",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    title: "Substrate — Foundational Systems",
    description: "Software infrastructure for durable systems.",
    url: "https://substratesystems.io",
    siteName: "Substrate",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: "/brand/logos/substrate-logo-dark.png",
        width: 1200,
        height: 630,
        alt: "Substrate",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Substrate — Foundational Systems",
    description: "Software infrastructure for durable systems.",
    images: ["/brand/logos/substrate-logo-dark.png"],
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
              sameAs: ["https://github.com/Artexis10"],
            }),
          }}
        />
      </head>
      <body className={`${inter.variable} antialiased`}>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
