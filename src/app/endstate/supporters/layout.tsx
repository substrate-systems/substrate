import type { Metadata } from "next";

const TITLE = "Supporters";
const DESCRIPTION =
  "The people who fund Endstate. They bought a Supporter License so the product can stay free, open, and without telemetry for everyone.";
const OG_IMAGE = `/api/og?title=${encodeURIComponent(TITLE)}`;

export const metadata: Metadata = {
  title: `${TITLE} — Endstate`,
  description: DESCRIPTION,
  openGraph: {
    title: `${TITLE} — Endstate`,
    description: DESCRIPTION,
    url: "https://substratesystems.io/endstate/supporters",
    siteName: "Substrate Systems",
    type: "website",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} — Endstate`,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
};

export default function SupportersLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
