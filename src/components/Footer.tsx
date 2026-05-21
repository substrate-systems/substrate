import Image from "next/image";
import Link from "next/link";

const navLinks = [
  { label: "Work", href: "/work" },
  { label: "Writing", href: "/blog" },
  { label: "Endstate", href: "/endstate" },
];

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="relative w-full py-16 border-t border-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-6 flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
        <Link href="/" aria-label="Substrate home" className="relative h-4 w-[160px] opacity-40 transition-opacity duration-default hover:opacity-70">
          <Image
            src="/brand/logos/substrate-logo-white-transparent.png"
            alt="Substrate"
            fill
            sizes="160px"
            className="object-contain"
          />
        </Link>

        <nav className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm font-light text-fg-tertiary transition-colors duration-default hover:text-fg-secondary"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <p className="text-sm font-light text-fg-tertiary">
          Substrate Systems · {currentYear}
        </p>
      </div>
    </footer>
  );
}
