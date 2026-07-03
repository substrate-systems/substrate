import { siteConfig } from "@/lib/seo";

// Author entity (E-E-A-T). Articles reference this; /work carries the canonical
// Person node. sameAs is Hugo's personal profile only (the LinkedIn page is the org).
export const PERSON = {
  "@type": "Person",
  name: "Hugo Ander Kivi",
  url: `${siteConfig.url}/work`,
  jobTitle: "Founder & Software Engineer",
  worksFor: { "@type": "Organization", name: siteConfig.name },
  sameAs: ["https://github.com/Artexis10"],
} as const;

export function personJsonLd() {
  return { "@context": "https://schema.org", ...PERSON };
}

export function articleJsonLd(input: {
  title: string;
  description: string;
  slug: string;
  published?: string;
  image?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.title,
    description: input.description,
    ...(input.published ? { datePublished: input.published } : {}),
    author: PERSON,
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      logo: {
        "@type": "ImageObject",
        url: `${siteConfig.url}/brand/logos/substrate-logo-dark.png`,
      },
    },
    mainEntityOfPage: `${siteConfig.url}/blog/${input.slug}`,
    ...(input.image ? { image: [input.image] } : {}),
  };
}

// HowTo structured data for the procedural guides. Google deprecated HowTo rich
// results (2023), so this is primarily a GEO signal — answer engines lift the steps.
const HOWTO_BY_SLUG: Record<
  string,
  { name: string; description: string; steps: { name: string; text: string }[] }
> = {
  "reinstall-all-apps-with-winget": {
    name: "How to reinstall all your apps with winget",
    description:
      "Export your installed Windows apps to one file with winget, then reinstall them on a new machine.",
    steps: [
      {
        name: "Export your installed apps",
        text: "Run `winget export -o apps.json` to write your winget-source apps to a single JSON file. Add --include-versions to pin exact versions.",
      },
      {
        name: "Reinstall on the new machine",
        text: "Run `winget import -i apps.json --accept-package-agreements --accept-source-agreements` to reinstall every app without clicking through installers.",
      },
    ],
  },
  "set-up-new-windows-pc-fast": {
    name: "How to set up a new Windows PC in minutes",
    description:
      "Capture your apps and settings once, then restore them on any fresh Windows install.",
    steps: [
      {
        name: "Capture your current machine",
        text: "List your installed apps with `winget export -o apps.json` and gather the settings for the tools you rely on.",
      },
      {
        name: "Save it somewhere you own",
        text: "Keep the file on a USB stick or your own sync folder so it works offline, with no account required.",
      },
      {
        name: "Restore on the fresh install",
        text: "Run `winget import` to reinstall the apps, then restore your settings and any Microsoft Store apps winget left out.",
      },
    ],
  },
};

export function howToJsonLd(slug: string) {
  const howto = HOWTO_BY_SLUG[slug];
  if (!howto) return null;
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: howto.name,
    description: howto.description,
    step: howto.steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.name,
      text: step.text,
    })),
  };
}
