import Link from "next/link";
import Footer from "@/components/Footer";
import { breadcrumbJsonLd, buildMetadata } from "@/lib/seo";
import { getSupportedApps } from "@/lib/endstate-apps";
import AppsList from "./AppsList";

// ISR: re-fetch the app list from the engine repo daily so this stays current
// as settings modules are added, without a manual rebuild.
export const revalidate = 86400;

export const metadata = buildMetadata({
  title: "Supported apps — Endstate backs up 300+ Windows apps",
  description:
    "The Windows apps Endstate backs up settings for and reinstalls on a new PC — 300+ and growing, from editors and creative tools to emulators. Free and open source.",
  path: "/endstate/apps",
});

export default async function AppsPage() {
  const apps = await getSupportedApps();

  // The live catalog is the truth, and it only grows. Print the real figure when the
  // GitHub listing succeeded; if it fell back to the short offline list, degrade to
  // the conservative "300+" rather than publishing a wrong, much smaller number.
  const appCount = apps.length >= 300 ? `${apps.length}` : "300+";

  const breadcrumb = breadcrumbJsonLd([
    { name: "Home", path: "/" },
    { name: "Endstate", path: "/endstate" },
    { name: "Supported apps", path: "/endstate/apps" },
  ]);

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Windows apps Endstate backs up settings for",
    numberOfItems: apps.length,
    itemListElement: apps.map((app, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: app.name,
    })),
  };

  return (
    <div className="min-h-screen bg-bg-base">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }}
      />

      <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-24">
        <span className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
          Endstate
        </span>
        <h1 className="mt-6 text-display-sm font-light tracking-tight text-fg-primary sm:text-display">
          Settings backup for {appCount} Windows apps
        </h1>
        <p className="mt-6 max-w-2xl text-body font-light text-fg-secondary">
          Endstate reinstalls your apps on a new Windows PC and restores their
          settings. Most migration tools reinstall the app and lose your
          configuration; Endstate brings both. Here is what it has settings
          modules for today. The list is open source and grows with every release.
        </p>
        <p className="mt-4 max-w-2xl text-body-sm text-fg-tertiary">
          Don&rsquo;t see yours? Modules are community-driven and easy to add.{" "}
          <a
            href="https://github.com/Artexis10/endstate"
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-secondary underline underline-offset-4 transition-colors duration-default hover:text-fg-primary"
          >
            Contribute on GitHub
          </a>
          .
        </p>

        <div className="mt-12">
          <AppsList apps={apps} />
        </div>

        <div className="mt-16 flex flex-wrap gap-x-6 gap-y-2 border-t border-border-subtle pt-10 text-body-sm">
          <Link
            href="/endstate"
            className="font-light text-fg-tertiary transition-colors duration-default hover:text-fg-secondary"
          >
            ← Back to Endstate
          </Link>
          <Link
            href="/download"
            className="font-light text-fg-tertiary transition-colors duration-default hover:text-fg-secondary"
          >
            Download free
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
