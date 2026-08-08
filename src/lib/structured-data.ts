import { siteConfig } from "@/lib/seo";

// Author entity (E-E-A-T). Articles reference this; /work carries the canonical
// Person node. sameAs is Hugo's personal profile only (the LinkedIn page is the org).
export const PERSON = {
  "@type": "Person",
  name: "Hugo Ander Kivi",
  url: `${siteConfig.url}/work`,
  jobTitle: "Founder & Software Engineer",
  worksFor: { "@type": "Organization", name: siteConfig.name },
  sameAs: ["https://github.com/Artexis10", "https://x.com/hugoanderkivi"],
} as const;

export function personJsonLd() {
  return { "@context": "https://schema.org", ...PERSON };
}

export function articleJsonLd(input: {
  title: string;
  description: string;
  slug: string;
  published?: string;
  updated?: string;
  image?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.title,
    description: input.description,
    ...(input.published ? { datePublished: input.published } : {}),
    ...(input.updated ? { dateModified: input.updated } : {}),
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
  "transfer-programs-to-another-computer": {
    name: "How to transfer programs from one computer to another",
    description:
      "Installed Windows programs cannot be copied between machines. Capture what is installed and how it is configured, then reinstall cleanly on the new PC.",
    steps: [
      {
        name: "Capture what is installed",
        text: "Scan the old machine for its installed applications and their settings. `winget export -o apps.json` covers apps winget can identify; Endstate additionally detects Microsoft Store apps and backs up settings for 300+ applications.",
      },
      {
        name: "Save it to a file you control",
        text: "Write the result to a portable file on a USB stick or your own sync folder. No cloud account is required, and the file is plain and inspectable.",
      },
      {
        name: "Reinstall on the new machine",
        text: "Open the saved file on the new PC. Each application installs through its own installer, so it registers correctly rather than inheriting the old machine's state. Restore settings on top; Endstate takes a backup first, so a bad restore is one click to undo.",
      },
    ],
  },
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
  "restore-windows-apps-and-settings-after-reinstall": {
    name: "How to restore Windows apps and settings after reinstalling Windows",
    description:
      "Restore selected Windows applications and supported application settings from an Endstate profile captured before reinstalling Windows.",
    steps: [
      {
        name: "Open the Endstate setup flow",
        text: "Install Endstate on the fresh Windows installation, open it, and choose Set up this computer.",
      },
      {
        name: "Load the saved profile",
        text: "Load the Endstate profile captured before reinstalling Windows, or retrieve it from Endstate Cloud if you use that optional service.",
      },
      {
        name: "Review the comparison",
        text: "Review the comparison between the profile and the current computer to see what is already present, what can be installed, and which settings are available.",
      },
      {
        name: "Select and apply the changes",
        text: "Select the applications and supported settings to restore, then apply the changes.",
      },
      {
        name: "Verify the resulting state",
        text: "Read the result, verify the applications you rely on, and check anything marked unavailable or skipped.",
      },
    ],
  },
  "share-your-app-setup": {
    name: "How to share your app setup with someone else",
    description: "Hand someone your exact app configuration as one portable file with Endstate.",
    steps: [
      {
        name: "Capture your setup",
        text: "Use Endstate to capture your apps and the settings you want to share into one portable file.",
      },
      {
        name: "Send the file",
        text: "Share the setup file however you share files — a message, a shared drive, or a repo. No account required.",
      },
      {
        name: "They restore what they want",
        text: "The recipient opens the file in Endstate; restore is opt-in per app, so they pull in only the configs they want, like your OBS or MSI Afterburner profile.",
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
