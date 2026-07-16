import Image from "next/image";
import Link from "next/link";

const navLinks = [
  { label: "Work", href: "/work" },
  { label: "Writing", href: "/blog" },
  { label: "Photography", href: "/photography" },
  { label: "Q", href: "https://useq.ai", external: true },
  { label: "Endstate", href: "/endstate" },
  { label: "Exomem", href: "/exomem" },
  { label: "GitHub", href: "https://github.com/Artexis10", external: true },
  { label: "LinkedIn", href: "https://www.linkedin.com/company/substratesystems/", external: true },
];

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="relative mt-[clamp(80px,11vh,120px)] w-full border-t border-border-subtle">
      <div className="mx-auto flex w-full max-w-[880px] flex-wrap items-center justify-between gap-x-10 gap-y-8 px-6 py-[60px]">
        <Link
          href="/"
          aria-label="Substrate home"
          className="relative h-[14px] w-[140px] opacity-40 transition-opacity duration-default hover:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#a3a3a3]"
        >
          <Image
            src="/brand/logos/substrate-logo-white-transparent.png"
            alt="Substrate"
            fill
            sizes="160px"
            className="object-contain"
          />
        </Link>

        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {navLinks.map((link) =>
            link.external ? (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-light text-[#7a7a7a] transition-colors duration-default hover:text-[#a3a3a3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#a3a3a3]"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-light text-[#7a7a7a] transition-colors duration-default hover:text-[#a3a3a3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#a3a3a3]"
              >
                {link.label}
              </Link>
            )
          )}
        </nav>

        <p className="text-sm font-light text-[#7a7a7a]">Substrate Systems · {currentYear}</p>
      </div>
    </footer>
  );
}
