import type { Metadata } from "next";
import type { ReactNode } from "react";
import { buildExomemMetadata } from "@/lib/exomem/metadata";

export const metadata: Metadata = {
  ...buildExomemMetadata({
    title: "Exomem — the knowledge base all your assistants share",
    description:
      "One knowledge base for Claude, ChatGPT, Claude Code and Codex. Keep what matters between conversations, as plain Markdown you own.",
    path: "/exomem",
  }),
  title: { default: "Exomem", template: "%s" },
  icons: {
    icon: [
      { url: "/exomem/icons/favicon.ico", sizes: "any" },
      { url: "/exomem/icons/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/exomem/icons/apple-touch-icon.png",
  },
  manifest: "/exomem/icons/site.webmanifest",
};

export default function ExomemLayout({ children }: { children: ReactNode }) {
  return children;
}
