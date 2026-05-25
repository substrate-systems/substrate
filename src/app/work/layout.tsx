import type { Metadata } from "next";

const TITLE = "Proof of work";
const DESCRIPTION =
  "Hugo Ander Kivi — selected work and writing on contract-based LLM governance for AI-augmented teams, plus Endstate (Windows backup) and Q (knowledge infrastructure).";
const OG_IMAGE = `/api/og?title=${encodeURIComponent(TITLE)}`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: `${TITLE} · Substrate`,
    description: DESCRIPTION,
    url: "/work",
    type: "profile",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} · Substrate`,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
};

export default function WorkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
