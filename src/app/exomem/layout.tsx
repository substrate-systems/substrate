import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
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
