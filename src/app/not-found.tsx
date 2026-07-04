import Link from "next/link";
import Footer from "@/components/Footer";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-bg-base text-fg-primary">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-start justify-center px-6 py-24">
        <p className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">404</p>
        <h1 className="mt-5 text-3xl font-light tracking-tight text-fg-primary sm:text-4xl">
          This page doesn&apos;t exist.
        </h1>
        <p className="mt-4 max-w-xl text-body font-light leading-relaxed text-fg-secondary">
          The address may have changed, or the page was never here. Everything
          that is here is reachable from the pages below.
        </p>
        <nav className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-sm font-light">
          <Link
            href="/"
            className="text-fg-secondary transition-colors duration-default hover:text-fg-primary"
          >
            Home
          </Link>
          <Link
            href="/endstate"
            className="text-fg-secondary transition-colors duration-default hover:text-fg-primary"
          >
            Endstate
          </Link>
          <Link
            href="/exomem"
            className="text-fg-secondary transition-colors duration-default hover:text-fg-primary"
          >
            Exomem
          </Link>
          <Link
            href="/blog"
            className="text-fg-secondary transition-colors duration-default hover:text-fg-primary"
          >
            Writing
          </Link>
        </nav>
      </main>
      <Footer />
    </div>
  );
}
