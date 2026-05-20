import { existsSync } from "node:fs";
import path from "node:path";
import Image from "next/image";
import Link from "next/link";
import Footer from "@/components/Footer";

// Owner-supplied, gated assets. The links render only when these are present,
// so the page never ships a broken link. Set LINKEDIN_URL when provided; drop
// the CV PDF into public/downloads/ to enable the download link.
const LINKEDIN_URL = "https://www.linkedin.com/in/hugo-ander-kivi/";
const CV_FILENAME = "hugo-ander-kivi-cv.pdf";
const cvAvailable = existsSync(path.join(process.cwd(), "public/downloads", CV_FILENAME));

const workItems = [
  {
    name: "Endstate",
    description:
      "Capture a Windows machine's apps and settings, then restore them on a fresh install. Local-first, with optional end-to-end encrypted backup. A shipped desktop product.",
    links: [
      { label: "Overview →", href: "/endstate", external: false },
      { label: "Source ↗", href: "https://github.com/Artexis10/endstate", external: true },
    ],
  },
  {
    name: "Q",
    description:
      "AI knowledge infrastructure. Turn a content library into a branded, searchable knowledge base with citations back to the original source.",
    links: [{ label: "Visit ↗", href: "https://useq.ai", external: true }],
  },
];

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">{children}</span>
  );
}

export default function WorkPage() {
  return (
    <div className="min-h-screen bg-bg-base">
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

      <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:py-20">
        {/* Intro / positioning */}
        <section>
          <Label>Work</Label>
          <h1 className="mt-4 text-display-sm font-light tracking-tight text-fg-primary sm:text-display">
            Hugo Ander Kivi
          </h1>
          <p className="mt-3 text-body-lg font-light text-fg-secondary">
            Senior software engineer. I build the architecture that lets AI-augmented teams
            move fast without breaking the rules that matter.
          </p>
          <p className="mt-6 max-w-2xl text-body font-light leading-relaxed text-fg-secondary">
            My contract-based governance framework runs in production on a high-throughput
            transaction platform that processes hundreds of millions of operations a day. It
            encodes business invariants into versioned contracts and binds them to the agent
            at the moment of the task, so AI-augmented work ships without a human re-reviewing
            every step. I operate this work through Substrate Systems, my software company.
          </p>
        </section>

        {/* Writing */}
        <section className="mt-16 border-t border-border-subtle pt-16">
          <Label>Writing</Label>
          <Link href="/blog/governance-as-compression" className="group mt-6 block">
            <h2 className="text-xl font-light tracking-tight text-fg-primary transition-colors duration-default group-hover:text-white sm:text-2xl">
              Governance as compression: contracts and skills for AI-augmented codebases
            </h2>
            <p className="mt-3 max-w-2xl text-body font-light text-fg-secondary">
              The contract-and-skill pattern I shipped to production, and the controlled
              three-condition benchmark that showed the binding mechanism — not the
              documentation — is what moves outcomes.
            </p>
            <span className="mt-3 inline-block text-sm font-light text-fg-tertiary transition-colors duration-default group-hover:text-fg-secondary">
              Read →
            </span>
          </Link>
        </section>

        {/* Selected work */}
        <section className="mt-16 border-t border-border-subtle pt-16">
          <Label>Selected work</Label>
          <div className="mt-8 space-y-12">
            {workItems.map((item) => (
              <div key={item.name}>
                <h2 className="text-xl font-light tracking-tight text-fg-primary sm:text-2xl">
                  {item.name}
                </h2>
                <p className="mt-3 max-w-2xl text-body font-light text-fg-secondary">
                  {item.description}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
                  {item.links.map((link) =>
                    link.external ? (
                      <a
                        key={link.href}
                        href={link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-light text-fg-tertiary transition-colors duration-default hover:text-fg-secondary"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        key={link.href}
                        href={link.href}
                        className="text-sm font-light text-fg-tertiary transition-colors duration-default hover:text-fg-secondary"
                      >
                        {link.label}
                      </Link>
                    )
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Links / contact */}
        <section className="mt-16 border-t border-border-subtle pt-16">
          <Label>Elsewhere</Label>
          <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
            <a
              href="https://github.com/Artexis10"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body font-light text-fg-secondary transition-colors duration-default hover:text-fg-primary"
            >
              GitHub ↗
            </a>
            <a
              href="mailto:founder@substratesystems.io"
              className="text-body font-light text-fg-secondary transition-colors duration-default hover:text-fg-primary"
            >
              Email
            </a>
            {LINKEDIN_URL ? (
              <a
                href={LINKEDIN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-body font-light text-fg-secondary transition-colors duration-default hover:text-fg-primary"
              >
                LinkedIn ↗
              </a>
            ) : null}
            {cvAvailable ? (
              <a
                href={`/downloads/${CV_FILENAME}`}
                className="text-body font-light text-fg-secondary transition-colors duration-default hover:text-fg-primary"
              >
                Download CV ↓
              </a>
            ) : null}
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
