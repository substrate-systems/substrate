import type { Metadata } from "next";
import { buildMetadata } from "@/lib/seo";
import { productPageUrl } from "./product-site";

export function buildExomemMetadata(
  input: Omit<Parameters<typeof buildMetadata>[0], "standaloneTitle">
): Metadata {
  const metadata = buildMetadata({
    ...input,
    ogImage: input.ogImage ?? "/evermatter/social/og-image.png",
    standaloneTitle: true,
  });
  const url = productPageUrl(input.path);
  return {
    ...metadata,
    alternates: { ...metadata.alternates, canonical: url },
    openGraph: { ...metadata.openGraph, url, siteName: "Evermatter" },
  };
}
