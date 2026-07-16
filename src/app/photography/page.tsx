import Image from "next/image";
import Link from "next/link";
import Footer from "@/components/Footer";
import PhotographyHeader from "@/components/photography/PhotographyHeader";
import { icelandAuroraSeries } from "@/lib/photography";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Photography by Hugo Ander Kivi",
  description:
    "Authored photography by Hugo Ander Kivi: a quieter extension of the same attention, atmosphere, structure, and restraint behind Substrate.",
  path: "/photography",
  authors: ["Hugo Ander Kivi"],
});

export default function PhotographyPage() {
  const cover =
    icelandAuroraSeries.images.find((image) => image.src === icelandAuroraSeries.cover) ??
    icelandAuroraSeries.images[0];

  return (
    <div className="min-h-screen bg-bg-base">
      <PhotographyHeader />
      <main>
        <section className="mx-auto w-full max-w-5xl px-5 pb-20 pt-24 sm:px-8 sm:pb-28 sm:pt-32 lg:px-12 lg:pt-40">
          <p className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">Photography</p>
          <h1 className="mt-5 max-w-3xl text-4xl font-light tracking-[-0.025em] text-fg-primary sm:text-6xl lg:text-7xl">
            The same eye, elsewhere.
          </h1>
          <p className="mt-7 max-w-2xl text-base font-light leading-relaxed text-fg-secondary sm:text-lg">
            Photography is a quieter part of the same practice behind Substrate: attention,
            atmosphere, structure, and restraint.
          </p>
        </section>

        <section className="mx-auto w-full max-w-[90rem] px-5 pb-28 sm:px-8 sm:pb-40 lg:px-12">
          <Link
            href="/photography/iceland-aurora"
            className="group block focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-white/70"
          >
            <div
              className="relative w-full overflow-hidden bg-bg-surface"
              style={{ aspectRatio: `${cover.width} / ${cover.height}` }}
            >
              <Image
                src={cover.src}
                alt={cover.alt}
                fill
                priority
                sizes="(min-width: 1440px) 1344px, 100vw"
                className="object-cover transition-[opacity,transform] duration-emphasis ease-out group-hover:scale-[1.008] group-hover:opacity-90 motion-reduce:transform-none motion-reduce:transition-none"
              />
            </div>
            <div className="mt-5 flex items-end justify-between gap-6 border-t border-border-subtle pt-5 sm:mt-7 sm:pt-7">
              <div>
                <h2 className="text-2xl font-light tracking-tight text-fg-primary sm:text-3xl">
                  {icelandAuroraSeries.title}
                </h2>
                <p className="mt-2 text-sm font-light text-fg-tertiary">
                  {icelandAuroraSeries.location} · {icelandAuroraSeries.date}
                </p>
              </div>
              <span className="pb-1 text-sm font-light text-fg-tertiary transition-colors duration-default group-hover:text-fg-primary motion-reduce:transition-none">
                View series →
              </span>
            </div>
          </Link>
        </section>
      </main>
      <Footer />
    </div>
  );
}
