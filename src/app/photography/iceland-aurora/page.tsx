import Link from "next/link";
import Footer from "@/components/Footer";
import PhotographyGallery from "@/components/photography/PhotographyGallery";
import PhotographyHeader from "@/components/photography/PhotographyHeader";
import { icelandAuroraSeries } from "@/lib/photography";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Iceland Aurora — Photography by Hugo Ander Kivi",
  description:
    "An Iceland aurora photography series moving from landscape into light, motion, and abstraction — then back again.",
  path: "/photography/iceland-aurora",
  authors: ["Hugo Ander Kivi"],
});

export default function IcelandAuroraPage() {
  return (
    <div className="min-h-screen bg-bg-base">
      <PhotographyHeader />
      <main>
        <header className="mx-auto w-full max-w-5xl px-5 pb-16 pt-20 sm:px-8 sm:pb-24 sm:pt-28 lg:px-12 lg:pt-36">
          <Link
            href="/photography"
            className="text-xs uppercase tracking-[0.2em] text-fg-tertiary transition-colors duration-default hover:text-fg-secondary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-white/60"
          >
            ← Photography
          </Link>
          <h1 className="mt-8 text-4xl font-light tracking-[-0.025em] text-fg-primary sm:text-6xl lg:text-7xl">
            {icelandAuroraSeries.title}
          </h1>
          <div className="mt-5 flex flex-wrap gap-x-3 text-sm font-light text-fg-tertiary">
            <span>{icelandAuroraSeries.location}</span>
            <span aria-hidden="true">·</span>
            <span>{icelandAuroraSeries.date}</span>
          </div>
          <p className="mt-7 max-w-2xl text-base font-light leading-relaxed text-fg-secondary sm:text-lg">
            {icelandAuroraSeries.introduction}
          </p>
        </header>

        <PhotographyGallery images={icelandAuroraSeries.images} />
      </main>
      <Footer />
    </div>
  );
}
