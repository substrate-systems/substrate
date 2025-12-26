import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Substrate — Foundational Systems",
  description:
    "Systems-first engineering for complex, long-horizon problems.",
  metadataBase: new URL("https://substrate.systems"),
  openGraph: {
    title: "Substrate — Foundational Systems",
    description:
      "Software infrastructure for durable systems. Systems-first engineering for complex, long-horizon problems.",
    url: "https://substrate.systems",
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
    description:
      "Software infrastructure for durable systems. Systems-first engineering for complex, long-horizon problems.",
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
      <body className={`${inter.variable} antialiased`}>{children}</body>
    </html>
  );
}
