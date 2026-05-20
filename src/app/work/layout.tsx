import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Work · Hugo Ander Kivi",
  description:
    "Hugo Ander Kivi — selected work and writing. Contract-based LLM governance in production, Endstate, and Q.",
  openGraph: {
    title: "Work · Hugo Ander Kivi",
    description:
      "Hugo Ander Kivi — selected work and writing. Contract-based LLM governance in production, Endstate, and Q.",
    url: "/work",
    type: "profile",
  },
};

export default function WorkLayout({ children }: { children: React.ReactNode }) {
  return children;
}
