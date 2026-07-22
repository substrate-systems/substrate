import { buildMetadata } from "@/lib/seo";
import { dmSans, jetbrainsMono } from "@/lib/fonts";

const DESCRIPTION =
  "Endstate scans your Windows PC, saves your apps and settings to one portable file, and reinstalls everything on a fresh machine in minutes. Free, open-source, local-first — no account.";

export const metadata = {
  ...buildMetadata({
    title: "Endstate — Set Up a New Windows PC & Restore Your Apps in Minutes",
    description: DESCRIPTION,
    path: "/endstate",
    ogImage: "/endstate/og",
    standaloneTitle: true,
  }),
  // Endstate subtree uses its own mark as the favicon.
  icons: { icon: "/endstate/icons/dark-full/dark-sw4.svg" },
};

export default function EndstateLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${dmSans.variable} ${jetbrainsMono.variable}`}>{children}</div>
  );
}
