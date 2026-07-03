import type { Metadata } from "next";

/**
 * Single source of truth for site-wide SEO/GEO metadata. Every page builds its
 * metadata through `buildMetadata` so brand naming, canonical URLs, and OG/Twitter
 * defaults stay consistent instead of drifting across per-page layouts.
 */
export const siteConfig = {
  url: "https://substratesystems.io",
  /** OG siteName + JSON-LD publisher. Matches the on-page nav and Organization schema. */
  name: "Substrate Systems",
  /** Short brand used only in the `<title>` suffix. */
  shortName: "Substrate",
  titleSuffix: "· Substrate",
  defaultTitle: "Substrate — durable software infrastructure & systems",
  defaultDescription:
    "Substrate builds durable, self-hostable software infrastructure — Endstate for new-PC setup and Exomem agent memory. Solo-built, no lock-in, no telemetry.",
  defaultOgImage: "/api/og",
  locale: "en_US",
  twitterCard: "summary_large_image" as const,
} as const;

type BuildMetadataInput = {
  /** Bare title, no brand suffix. */
  title: string;
  description: string;
  /** Path like "/endstate" — drives both the canonical link and og:url. */
  path: string;
  ogImage?: string;
  ogType?: "website" | "article" | "profile";
  /**
   * true for product/landing pages that own a full, keyword-rich title and should
   * NOT get the "· Substrate" template append (which would push them past ~60 chars).
   */
  standaloneTitle?: boolean;
  /** ISO date for article OG. */
  publishedTime?: string;
  authors?: string[];
  /** true = emit robots noindex (still followable). */
  noIndex?: boolean;
};

export function buildMetadata(input: BuildMetadataInput): Metadata {
  const {
    title,
    description,
    path,
    ogImage = siteConfig.defaultOgImage,
    ogType = "website",
    standaloneTitle = false,
    publishedTime,
    authors,
    noIndex,
  } = input;

  // Normal pages rely on the root title template ("%s · Substrate"). Standalone pages
  // bypass it with `absolute`. OG/Twitter titles never receive the template, so build
  // the branded form explicitly.
  const titleField: Metadata["title"] = standaloneTitle ? { absolute: title } : title;
  const socialTitle = standaloneTitle ? title : `${title} ${siteConfig.titleSuffix}`;

  return {
    title: titleField,
    description,
    alternates: { canonical: path },
    ...(authors ? { authors: authors.map((name) => ({ name })) } : {}),
    ...(noIndex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      title: socialTitle,
      description,
      url: path,
      siteName: siteConfig.name,
      locale: siteConfig.locale,
      type: ogType,
      ...(publishedTime ? { publishedTime } : {}),
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: siteConfig.twitterCard,
      title: socialTitle,
      description,
      images: [ogImage],
    },
  };
}

type BreadcrumbItem = { name: string; path: string };

/** Returns a schema.org BreadcrumbList object for injection as JSON-LD. */
export function breadcrumbJsonLd(items: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: `${siteConfig.url}${item.path}`,
    })),
  };
}
