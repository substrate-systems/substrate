import type { Metadata } from "next";
import Link from "next/link";
import Footer from "@/components/Footer";

const TITLE = "Exomem";
const DESCRIPTION =
  "External memory for MCP-capable agents over an owned Markdown and Obsidian vault.";
const OG_IMAGE = "/exomem/og";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: `${TITLE} · Substrate`,
    description: DESCRIPTION,
    url: "/exomem",
    type: "website",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${TITLE} · Substrate`,
    description: DESCRIPTION,
    images: [OG_IMAGE],
  },
};

const capabilities = [
  "MCP tools for search, capture, notes, evidence, audit, and review queues",
  "Hybrid keyword and vector retrieval over typed Markdown knowledge bases",
  "Local OCR, ASR, PDF, Office document, and CLIP image indexing",
  "CLI and REST surfaces generated from the same operation registry",
];

const surfaces = [
  {
    label: "MCP",
    text: "Use the same memory from Codex, Claude Code, Cursor, or custom agents.",
  },
  {
    label: "Files",
    text: "Keep Markdown, sources, evidence, and compiled notes in a vault you control.",
  },
  {
    label: "Review",
    text: "Surface stale conclusions, unprocessed sources, and nearby claims for human review.",
  },
];

export default function ExomemPage() {
  return (
    <div className="min-h-screen bg-bg-base text-fg-primary">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-8">
        <Link
          href="/"
          className="text-sm font-light text-fg-tertiary transition-colors duration-default hover:text-fg-secondary"
        >
          Substrate Systems
        </Link>
        <nav className="flex items-center gap-5 text-sm font-light text-fg-tertiary">
          <a
            href="https://github.com/Artexis10/exomem"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors duration-default hover:text-fg-secondary"
          >
            GitHub
          </a>
          <a
            href="https://pypi.org/project/exomem/"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors duration-default hover:text-fg-secondary"
          >
            PyPI
          </a>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid w-full max-w-6xl gap-14 px-6 pb-24 pt-10 lg:grid-cols-[1fr_0.9fr] lg:items-center lg:pb-32 lg:pt-20">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
              External memory for agents
            </p>
            <h1 className="mt-5 text-display-sm font-light tracking-tight text-fg-primary sm:text-display lg:text-[5rem] lg:leading-[0.95]">
              Exomem
            </h1>
            <p className="mt-6 max-w-2xl text-body-lg font-light leading-relaxed text-fg-secondary">
              An MCP-native memory layer over your own Markdown and Obsidian vault.
              Agents get durable context; you keep the files, provenance, and review loop.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="https://github.com/Artexis10/exomem"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md bg-fg-primary px-5 py-3 text-sm font-medium text-bg-base transition-opacity duration-default hover:opacity-85"
              >
                View source
              </a>
              <a
                href="https://pypi.org/project/exomem/"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md border border-border-default px-5 py-3 text-sm font-medium text-fg-primary transition-colors duration-default hover:border-border-emphasis"
              >
                Install from PyPI
              </a>
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle bg-bg-elevated/70 p-4 shadow-[0_24px_80px_rgba(0,0,0,0.32)]">
            <div className="rounded-md border border-border-subtle bg-black/40 p-4 font-mono text-xs text-fg-secondary sm:text-sm">
              <div className="mb-4 flex items-center gap-2 border-b border-border-subtle pb-3 text-fg-tertiary">
                <span className="h-2.5 w-2.5 rounded-full bg-[#ef4444]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#eab308]" />
                <span className="h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
                <span className="ml-2">agent-memory</span>
              </div>
              <pre className="whitespace-pre-wrap leading-relaxed text-fg-secondary">{`$ kb find "stale decision" --json
{
  "success": true,
  "data": [
    "Notes/Research/Project/old-plan.md",
    "Notes/Insights/newer-constraint.md"
  ]
}

$ kb note --note-type insight \
  --title "Agents need durable context"`}</pre>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {surfaces.map((surface) => (
                <div key={surface.label} className="border-t border-border-subtle pt-3">
                  <p className="text-xs uppercase tracking-[0.16em] text-fg-tertiary">
                    {surface.label}
                  </p>
                  <p className="mt-2 text-sm font-light leading-relaxed text-fg-secondary">
                    {surface.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border-subtle px-6 py-24">
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.85fr_1fr]">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
                Why it exists
              </p>
              <h2 className="mt-4 text-3xl font-light tracking-tight text-fg-primary sm:text-4xl">
                Memory should be inspectable infrastructure, not hidden assistant state.
              </h2>
            </div>
            <div className="space-y-6 text-body font-light leading-relaxed text-fg-secondary">
              <p>
                Exomem gives agents a shared substrate without asking you to move your
                knowledge into another app. The source material, compiled notes, entities,
                evidence, and supersession history remain plain files.
              </p>
              <p>
                The server measures and routes: search results, embeddings, extraction,
                file writes, graph health, and review queues. Judgment stays with the
                human and the client model using the tools.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-border-subtle px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <p className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
              Capabilities
            </p>
            <div className="mt-10 grid gap-5 md:grid-cols-2">
              {capabilities.map((capability) => (
                <div key={capability} className="border-t border-border-subtle pt-5">
                  <p className="text-body font-light leading-relaxed text-fg-secondary">
                    {capability}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border-subtle px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <p className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
              Install
            </p>
            <div className="mt-6 rounded-lg border border-border-subtle bg-bg-elevated/70 p-5 font-mono text-sm text-fg-secondary">
              <p>pip install exomem</p>
              <p className="mt-2">exomem --help</p>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-sm font-light">
              <a
                href="https://github.com/Artexis10/exomem"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg-secondary transition-colors duration-default hover:text-fg-primary"
              >
                GitHub source
              </a>
              <a
                href="https://pypi.org/project/exomem/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg-secondary transition-colors duration-default hover:text-fg-primary"
              >
                PyPI package
              </a>
              <a
                href="https://github.com/Artexis10/exomem/blob/main/README.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg-secondary transition-colors duration-default hover:text-fg-primary"
              >
                README
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}