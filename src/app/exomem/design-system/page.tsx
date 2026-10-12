import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { exomemTokens } from "@/lib/exomem/design-tokens";
import { DesignSystemShowcase } from "./showcase";

export const metadata: Metadata = {
  title: "Exomem design system",
  robots: { index: false, follow: false },
};

/**
 * Every Exomem component in each of its states, dark and light side by side, for QA
 * and review to compare with the R40 board before a surface ships. Not linked from
 * anywhere, and never served in production.
 */
export default function DesignSystemPage() {
  if (process.env.VERCEL_ENV === "production") notFound();
  return <DesignSystemShowcase tokens={exomemTokens()} />;
}
