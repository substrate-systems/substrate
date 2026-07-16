import Image from "next/image";
import Link from "next/link";

export default function PhotographyHeader() {
  return (
    <header className="mx-auto w-full max-w-[90rem] px-5 pt-7 sm:px-8 sm:pt-10 lg:px-12">
      <div className="flex items-center justify-between">
        <Link
          href="/"
          aria-label="Substrate home"
          className="relative block h-4 w-[160px] opacity-50 transition-opacity duration-default hover:opacity-80 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-white/60"
        >
          <Image
            src="/brand/logos/substrate-logo-white-transparent.png"
            alt="Substrate"
            fill
            sizes="160px"
            className="object-contain"
          />
        </Link>
        <Link
          href="/photography"
          className="text-xs uppercase tracking-[0.2em] text-fg-tertiary transition-colors duration-default hover:text-fg-secondary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-4 focus-visible:outline-white/60"
        >
          Photography
        </Link>
      </div>
    </header>
  );
}
