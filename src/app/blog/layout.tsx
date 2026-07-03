import type { Metadata } from "next";
import { siteConfig } from "@/lib/seo";

// Template applies to child post segments (blog/[slug]). The index page sets its own
// full metadata below in page.tsx. `default` is a suffix-free fallback (the root
// template appends "· Substrate").
export const metadata: Metadata = {
  title: {
    template: `%s ${siteConfig.titleSuffix}`,
    default: "Writing on infrastructure & LLM governance",
  },
};

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return children;
}
