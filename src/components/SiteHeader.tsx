import Image from "next/image";
import Link from "next/link";

/** The company logo header shared by the company's content pages. */
export default function SiteHeader() {
  return (
    <header className="mx-auto w-full max-w-3xl px-6 pt-10 sm:pt-14">
      <Link
        href="/"
        aria-label="Substrate home"
        className="inline-block opacity-40 transition-opacity duration-default hover:opacity-70"
      >
        <span className="relative block h-4 w-[160px]">
          <Image
            src="/brand/logos/substrate-logo-white-transparent.png"
            alt="Substrate"
            fill
            sizes="160px"
            className="object-contain"
          />
        </span>
      </Link>
    </header>
  );
}
