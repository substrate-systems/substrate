import { DM_Sans, JetBrains_Mono } from "next/font/google";

// Self-hosted via next/font (no render-blocking Google Fonts <link>). Both are
// variable fonts, so omitting `weight` loads the full axis (DM Sans 100–1000,
// JetBrains Mono 100–800) — covering every weight the Endstate sub-brand uses.
// Exposed as CSS variables and referenced as `var(--font-dm-sans)` /
// `var(--font-jetbrains-mono)` in the Endstate pages' inline styles.
export const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});
