import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Endstate — Save your machine. Set up the next one.",
  description:
    "Endstate captures every app and setting on your Windows machine, then restores them on a fresh install. One scan. One file. Done.",
  openGraph: {
    title: "Endstate — Save your machine. Set up the next one.",
    description:
      "Declarative Windows machine provisioning. Capture every app and setting, restore on any machine.",
    url: "https://substratesystems.io/endstate",
    siteName: "Substrate Systems",
    type: "website",
    images: [
      {
        url: "/endstate/01-landing.png",
        width: 1400,
        height: 900,
        alt: "Endstate application",
      },
    ],
  },
  icons: {
    icon: "/endstate/icons/dark-full/dark-sw4.svg",
  },
};

export default function EndstateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
