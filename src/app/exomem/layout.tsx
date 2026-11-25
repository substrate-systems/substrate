import type { Metadata } from "next";
import type { ReactNode } from "react";
import { buildExomemMetadata } from "@/lib/exomem/metadata";

export const metadata: Metadata = {
  ...buildExomemMetadata({
    title: "Evermatter — the knowledge base all your assistants share",
    description:
      "One knowledge base for Claude, ChatGPT, Claude Code and Codex. Keep what matters between conversations, as plain Markdown you own.",
    path: "/exomem",
  }),
  title: { default: "Evermatter", template: "%s" },
  icons: {
    icon: [
      { url: "/evermatter/icons/favicon.ico", sizes: "any" },
      { url: "/evermatter/icons/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/evermatter/icons/apple-touch-icon.png",
  },
  manifest: "/evermatter/icons/site.webmanifest",
};

export default function ExomemLayout({ children }: { children: ReactNode }) {
  return children;
}
