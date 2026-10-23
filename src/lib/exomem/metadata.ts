import type { Metadata } from "next";
import { buildMetadata } from "@/lib/seo";

export function buildExomemMetadata(
  input: Omit<Parameters<typeof buildMetadata>[0], "standaloneTitle">
): Metadata {
  const metadata = buildMetadata({
    ...input,
    ogImage: input.ogImage ?? "/exomem/social/og-image.png",
    standaloneTitle: true,
  });
  return {
    ...metadata,
    openGraph: { ...metadata.openGraph, siteName: "Exomem" },
  };
}
