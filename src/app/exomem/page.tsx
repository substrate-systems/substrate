import Link from "next/link";
import Footer from "@/components/Footer";
import { breadcrumbJsonLd, buildMetadata, siteConfig } from "@/lib/seo";
import { faqs } from "./faq-data";

export const metadata = buildMetadata({
  title: "Exomem — long-term memory for AI agents over Markdown",
  description:
    "Give Claude, Codex, and Cursor persistent memory via MCP — over a Markdown and Obsidian vault you own. Hybrid search, local indexing, human review queues.",
  path: "/exomem",
  ogImage: "/exomem/og",
  standaloneTitle: true,
});

const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Exomem",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Windows, macOS, Linux",
  description:
    "Open-source, MCP-native long-term memory for AI agents over a Markdown and Obsidian vault you own. Hybrid keyword and vector retrieval — sub-second at 50,000 notes, measured — with local OCR, ASR, and image indexing.",
  url: `${siteConfig.url}/exomem`,
  downloadUrl: "https://pypi.org/project/exomem/",
  installUrl: "https://pypi.org/project/exomem/",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "EUR",
    availability: "https://schema.org/InStock",
  },
  author: {
    "@type": "Organization",
    name: siteConfig.name,
    url: siteConfig.url,
  },
  license: "https://github.com/Artexis10/exomem/blob/main/LICENSE",
  codeRepository: "https://github.com/Artexis10/exomem",
  programmingLanguage: "Python",
};

const breadcrumb = breadcrumbJsonLd([
  { name: "Home", path: "/" },
  { name: "Exomem", path: "/exomem" },
]);

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: typeof faq.a === "string" ? faq.a : (faq.aText ?? ""),
    },
  })),
};

const capabilities = [
  "MCP tools for search, capture, notes, evidence, audit, and review queues",
  "Hybrid keyword and vector retrieval over typed Markdown knowledge bases — sub-second at 50,000 notes, measured",
  "Indexed lexical search (SQLite FTS5) and local vectors (sqlite-vec); no external search service",
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

const benchmarks = [
  {
    value: "864 ms",
    label: "Hybrid find() end-to-end at 50,000 notes, measured with hot cache off",
  },
  {
    value: "single-digit ms",
    label: "Keyword and lexical lanes, served straight from the SQLite FTS5 index",
  },
  {
    value: "zero",
    label: "Cloud dependencies in the lean install — a GPU is optional, never required",
  },
];

export default function ExomemPage() {
  return (
    <div className="min-h-screen bg-bg-base text-fg-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
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
              Measured at scale
            </p>
            <h2 className="mt-4 max-w-3xl text-3xl font-light tracking-tight text-fg-primary sm:text-4xl">
              Sub-second retrieval at 50,000 notes — measured, not asserted.
            </h2>
            <p className="mt-6 max-w-2xl text-body font-light leading-relaxed text-fg-secondary">
              Most memory tools claim they scale. Exomem publishes the numbers. Hybrid{" "}
              <span className="font-mono text-fg-primary">find()</span> runs end-to-end
              in under a second on a 50,000-note vault, with the keyword and lexical
              lanes answering in milliseconds from the FTS5 index — and the full
              methodology is in the repository so you can reproduce it.
            </p>
            <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-border-subtle bg-border-subtle sm:grid-cols-3">
              {benchmarks.map((benchmark) => (
                <div key={benchmark.value} className="bg-bg-base p-6">
                  <p className="font-mono text-3xl font-light tracking-tight text-fg-primary">
                    {benchmark.value}
                  </p>
                  <p className="mt-3 text-sm font-light leading-relaxed text-fg-secondary">
                    {benchmark.label}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-6 text-sm font-light text-fg-tertiary">
              Reference desktop — Ryzen 7 5800X3D, RTX 5080, 32 GB RAM.{" "}
              <a
                href="https://github.com/Artexis10/exomem/blob/main/docs/benchmarks.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-fg-secondary underline decoration-border-emphasis underline-offset-4 transition-opacity duration-default hover:opacity-70"
              >
                See the methodology
              </a>
            </p>
          </div>
        </section>

        <section className="border-t border-border-subtle px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <p className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
              The difference
            </p>
            <h2 className="mt-4 max-w-3xl text-3xl font-light tracking-tight text-fg-primary sm:text-4xl">
              Your memory stays yours — not extracted into someone else's cloud.
            </h2>
            <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-border-subtle bg-border-subtle md:grid-cols-2">
              <div className="bg-bg-base p-8">
                <p className="text-xs uppercase tracking-[0.16em] text-fg-tertiary">
                  Cloud memory services
                </p>
                <ul className="mt-5 space-y-3 text-body font-light leading-relaxed text-fg-secondary">
                  <li>Extract your data into a vector database or knowledge graph in their cloud</li>
                  <li>The memory is a derived copy — you never get plain files back</li>
                  <li>Account and subscription required; your data leaves your machine</li>
                </ul>
              </div>
              <div className="bg-bg-base p-8">
                <p className="text-xs uppercase tracking-[0.16em] text-fg-primary">
                  Exomem
                </p>
                <ul className="mt-5 space-y-3 text-body font-light leading-relaxed text-fg-secondary">
                  <li>Your notes stay plain Markdown in a vault you own and can edit anywhere</li>
                  <li>The index is a local SQLite sidecar — the files themselves are the memory</li>
                  <li>Self-hosted, no account; with the lean install, nothing leaves your machine</li>
                </ul>
              </div>
            </div>
            <p className="mt-8 text-body font-light text-fg-secondary">
              <Link
                href="/blog/exomem-vs-mem0-letta-zep"
                className="text-fg-primary underline decoration-border-emphasis underline-offset-4 transition-opacity duration-default hover:opacity-70"
              >
                See the full comparison vs mem0, Letta, Zep, cognee, and Basic Memory
              </Link>
            </p>
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
              <Link
                href="/blog"
                className="text-fg-secondary transition-colors duration-default hover:text-fg-primary"
              >
                Writing
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-border-subtle px-6 py-24">
          <div className="mx-auto max-w-4xl">
            <p className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
              FAQ
            </p>
            <h2 className="mt-4 text-3xl font-light tracking-tight text-fg-primary sm:text-4xl">
              Common questions
            </h2>
            <div className="mt-10 border-t border-border-subtle">
              {faqs.map((faq) => (
                <div key={faq.q} className="border-b border-border-subtle py-6">
                  <h3 className="text-lg font-light tracking-tight text-fg-primary">
                    {faq.q}
                  </h3>
                  <p className="mt-3 text-body font-light leading-relaxed text-fg-secondary">
                    {faq.a}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}