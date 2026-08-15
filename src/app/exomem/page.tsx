import type { CSSProperties } from "react";
import Link from "next/link";
import { breadcrumbJsonLd, buildMetadata, siteConfig } from "@/lib/seo";
import RevealManager from "./reveal-manager";
import MemoryGraph from "./memory-graph";
import CopyButton from "./copy-button";
import HostedAccessForm from "./hosted-access-form";
import FaqAccordion, { type ExoFaq } from "./faq-accordion";
import { GithubMark } from "@/components/GithubMark";

export const metadata = {
  ...buildMetadata({
    // Retargeted 2026-07-25 against measured demand: "mcp memory server" (KD 22) and
    // "markdown knowledge base" (KD 8) are both reachable at this domain's authority,
    // where "agent memory" (KD 33+) is not. Kept to 60 characters — the site audit
    // flagged over-long titles elsewhere.
    title: "Exomem — MCP memory server over your Markdown knowledge base",
    description:
      "Exomem is an open-source MCP memory server that turns the Markdown knowledge base you already own into durable memory for Claude Code, Codex and Cursor. Hybrid local search, no cloud, no lock-in.",
    path: "/exomem",
    ogImage: "/exomem/og",
    standaloneTitle: true,
  }),
  // Exomem subtree uses its own "E" monogram as the favicon (matches /exomem/og lockup).
  icons: { icon: "/exomem/icons/mark.svg" },
};

const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Exomem",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Windows, macOS, Linux",
  description:
    "Open-source MCP memory server over a Markdown knowledge base you own — a plain folder or an Obsidian vault. Hybrid keyword and vector retrieval, sub-second at 50,000 notes, measured, with local OCR, ASR, and image indexing.",
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
  sameAs: ["https://github.com/Artexis10/exomem", "https://pypi.org/project/exomem/"],
  // SoftwareApplication does not carry `codeRepository` or `programmingLanguage`; both
  // belong to SoftwareSourceCode, and emitting them here invalidated the entire item.
  isBasedOn: {
    "@type": "SoftwareSourceCode",
    name: "Exomem",
    description:
      "Open-source MCP server exposing a Markdown or Obsidian vault as a governed, searchable knowledge substrate.",
    codeRepository: "https://github.com/Artexis10/exomem",
    programmingLanguage: "Python",
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
  },
};

const breadcrumb = breadcrumbJsonLd([
  { name: "Home", path: "/" },
  { name: "Exomem", path: "/exomem" },
]);

const capabilities = [
  {
    num: "01",
    title: "MCP tools",
    text: "Search, capture, notes, evidence, audit, and review queues — usable from any MCP client.",
  },
  {
    num: "02",
    title: "Hybrid retrieval",
    text: "Keyword and vector search over typed Markdown knowledge bases. Sub-second at 50,000 notes, measured.",
  },
  {
    num: "03",
    title: "Local index",
    text: "SQLite FTS5 for lexical lanes, sqlite-vec for vectors. No external search service, ever.",
  },
  {
    num: "04",
    title: "Media ingestion",
    text: "Local OCR, ASR, PDF, Office extraction, and CLIP image indexing — screenshots and recordings become searchable.",
  },
  {
    num: "05",
    title: "One registry",
    text: "CLI and REST surfaces generated from the same operation registry as the MCP tools.",
  },
];

const benchmarks = [
  {
    value: "864",
    unit: "ms",
    color: "var(--exo-amber)", // the measured live value — amber is earned
    label:
      "Hybrid find() end-to-end at 50,000 notes — hot cache off, methodology public in the repo.",
  },
  {
    value: "<10",
    unit: "ms",
    color: "var(--fg-primary)",
    label: "Keyword and lexical lanes, served straight from the SQLite FTS5 index.",
  },
  {
    value: "0",
    unit: "cloud deps",
    color: "var(--fg-primary)",
    label: "In the lean install. A GPU is optional — never required.",
  },
];

// Grounded in faq-data.tsx / the exomem README; approved copy for the redesign.
const displayFaqs: ExoFaq[] = [
  {
    q: "Which agents and clients work with Exomem?",
    a: "Any MCP-capable client — Claude Code, Claude Desktop, Codex, Cursor, or a custom agent. The same memory is also reachable from a CLI (kb / exomem) and a personal REST facade, all generated from one operation registry.",
  },
  {
    q: "Do my notes ever leave my machine?",
    a: "No. Your vault stays plain Markdown files you own, and the search indexes are local SQLite sidecar files next to it. The lean install has no cloud dependency — nothing is uploaded.",
  },
  {
    q: "How fast is search on a large vault?",
    a: "Measured on a 50,000-note corpus: hybrid search runs end-to-end in 864 ms on the reference desktop, hot cache off, with the keyword and lexical lanes answering in milliseconds from the FTS5 index. The methodology is published in docs/benchmarks.md.",
  },
  {
    q: "How is Exomem different from cloud memory services?",
    a: "Cloud memory tools extract your data into a vector database or knowledge graph in their cloud. Exomem keeps your memory as plain Markdown in a vault you own and indexes it locally — your files are the memory, not a derived copy.",
  },
  {
    q: "Do I need a GPU?",
    a: "No. The lean install runs keyword and BM25 search out of the box — SQLite's FTS5 engine ships inside Python's standard library. Optional extras add local embeddings, CLIP image search, OCR, and speech-to-text; a GPU accelerates those, but is never required.",
  },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: displayFaqs.map((faq) => ({
    "@type": "Question",
    name: faq.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: faq.a,
    },
  })),
};

// ---- shared style tokens ----------------------------------------------------
const MONO = "var(--font-mono-exo)";

const shell: CSSProperties = {
  maxWidth: "72rem",
  margin: "0 auto",
  padding: "clamp(72px,10vh,120px) clamp(20px,5vw,48px)",
};
const sectionBorder: CSSProperties = { borderTop: "1px solid var(--exo-rule)" };
const label: CSSProperties = {
  margin: 0,
  fontFamily: MONO,
  fontSize: "11px",
  fontWeight: 500,
  letterSpacing: "0.18em",
  textTransform: "uppercase",
  color: "var(--fg-tertiary)",
};
const h2: CSSProperties = {
  margin: "24px 0 0",
  fontFamily: MONO,
  fontSize: "clamp(1.5rem,2.8vw,2.15rem)",
  fontWeight: 500,
  lineHeight: 1.3,
  letterSpacing: "-0.03em",
  color: "var(--fg-primary)",
};
const externalLink = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;

export default function ExomemPage() {
  return (
    <div className="brand-exomem" style={{ minHeight: "100vh" }}>
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
      <RevealManager />

      {/* ============ NAV ============ */}
      <header
        style={{
          maxWidth: "72rem",
          margin: "0 auto",
          padding: "28px clamp(20px,5vw,48px)",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <span
            aria-hidden="true"
            style={{
              width: "26px",
              height: "26px",
              borderRadius: "7px",
              background: "#171512",
              border: "1px solid rgba(236,233,226,0.14)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: MONO,
              fontSize: "14px",
              fontWeight: 600,
              color: "#fafafa",
            }}
          >
            E
          </span>
          <span
            style={{
              fontFamily: MONO,
              fontSize: "14px",
              fontWeight: 600,
              letterSpacing: "-0.02em",
              color: "var(--fg-primary)",
            }}
          >
            exomem
          </span>
          <Link href="/" className="exo-link-ts" style={{ fontSize: "12px", fontWeight: 300 }}>
            by Substrate Systems
          </Link>
        </div>
        <nav
          style={{
            display: "flex",
            alignItems: "center",
            gap: "22px",
            fontFamily: MONO,
            fontSize: "12px",
          }}
        >
          <a
            href="https://github.com/Artexis10/exomem"
            {...externalLink}
            className="exo-link-sp"
            style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <GithubMark size={13} />
            GitHub
          </a>
          {/* PyPI stays text: its mark is the Python blocks logo, which reads as
              "Python" beside the Octocat, and is a registered PSF trademark. */}
          <a href="https://pypi.org/project/exomem/" {...externalLink} className="exo-link-sp">
            PyPI
          </a>
        </nav>
      </header>

      <main>
        {/* ============ HERO ============ */}
        <section
          style={{
            maxWidth: "72rem",
            margin: "0 auto",
            padding: "clamp(40px,7vh,88px) clamp(20px,5vw,48px) clamp(72px,10vh,128px)",
          }}
        >
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,440px),1fr))",
              gap: "clamp(40px,5vw,72px)",
              alignItems: "center",
            }}
          >
            <div style={{ containerType: "inline-size" }}>
              <p data-reveal data-reveal-delay="0" style={label}>
                MCP memory server
              </p>
              <h1
                data-reveal
                data-reveal-delay="100"
                style={{
                  margin: "22px 0 0",
                  fontFamily: MONO,
                  fontSize: "clamp(1.75rem,8.4cqw,2.95rem)",
                  fontWeight: 600,
                  lineHeight: 1.12,
                  letterSpacing: "-0.045em",
                  color: "var(--fg-primary)",
                  textWrap: "balance",
                }}
              >
                Agents get memory.
                <br />
                You keep the files.
              </h1>
              <p
                data-reveal
                data-reveal-delay="200"
                style={{
                  margin: "26px 0 0",
                  maxWidth: "34rem",
                  fontSize: "1.125rem",
                  fontWeight: 300,
                  lineHeight: 1.7,
                  color: "var(--fg-secondary)",
                }}
              >
                Exomem is an open-source MCP memory server that runs over the Markdown knowledge
                base you already own — a plain folder, or your Obsidian vault. Claude Code, Codex,
                and Cursor get durable context; you keep the files, the provenance, and the review
                loop.
              </p>
              <div
                data-reveal
                data-reveal-delay="300"
                style={{
                  marginTop: "36px",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "12px",
                  alignItems: "center",
                }}
              >
                <a
                  href="https://github.com/Artexis10/exomem"
                  {...externalLink}
                  className="exo-cta-primary"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                    background: "var(--fg-primary)",
                    color: "var(--bg-base)",
                    fontFamily: MONO,
                    fontSize: "13px",
                    fontWeight: 500,
                    padding: "13px 22px",
                    borderRadius: "8px",
                    textDecoration: "none",
                  }}
                >
                  View source →
                </a>
                <CopyButton variant="cta" />
              </div>
              <p
                data-reveal
                data-reveal-delay="400"
                style={{
                  margin: "26px 0 0",
                  fontFamily: MONO,
                  fontSize: "11.5px",
                  color: "var(--fg-tertiary)",
                }}
              >
                Python · AGPL-3.0 · self-hosted · no account
              </p>
            </div>

            <MemoryGraph />
          </div>
        </section>

        {/* ============ 01 — WHY ============ */}
        <section style={sectionBorder}>
          <div style={shell}>
            <p data-reveal style={label}>
              01 — Why it exists
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,420px),1fr))",
                gap: "clamp(28px,4vw,64px)",
                marginTop: "28px",
              }}
            >
              <h2
                data-reveal
                data-reveal-delay="80"
                style={{ ...h2, margin: 0, textWrap: "balance" }}
              >
                Memory should be inspectable infrastructure you own — not hidden assistant state in
                someone else&rsquo;s cloud.
              </h2>
              <div
                data-reveal
                data-reveal-delay="180"
                style={{
                  fontSize: "1rem",
                  fontWeight: 300,
                  lineHeight: 1.75,
                  color: "var(--fg-secondary)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "20px",
                }}
              >
                <p style={{ margin: 0 }}>
                  Exomem gives agents a shared substrate without asking you to move your knowledge
                  into another app. Source material, compiled notes, typed entities, evidence, and
                  supersession history remain plain files — open any of them in a text editor.
                </p>
                <p style={{ margin: 0 }}>
                  The server measures and routes: search, embeddings, extraction, file writes, graph
                  health, review queues. Judgment stays with the human and the client model using
                  the tools.
                </p>
              </div>

              {/* file-proof card */}
              <div
                data-reveal
                data-reveal-delay="260"
                style={{
                  gridColumn: "1 / -1",
                  maxWidth: "44rem",
                  marginTop: "8px",
                }}
              >
                <div
                  style={{
                    border: "1px solid var(--exo-border-card)",
                    borderRadius: "12px",
                    background: "var(--bg-panel)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "12px",
                      padding: "12px 18px",
                      borderBottom: "1px solid var(--exo-rule)",
                      fontFamily: MONO,
                      fontSize: "11px",
                      color: "var(--fg-tertiary)",
                    }}
                  >
                    <span>notes/old-plan.md</span>
                    <span>plain Markdown</span>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: "18px 18px 20px",
                      fontFamily: MONO,
                      fontSize: "12.5px",
                      lineHeight: 1.8,
                      color: "var(--fg-secondary)",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                    }}
                  >
                    <span style={{ color: "var(--fg-tertiary)" }}>{"---\ntype:"}</span>
                    {" decision\n"}
                    <span style={{ color: "var(--fg-tertiary)" }}>status:</span>
                    {" superseded\n"}
                    <span style={{ color: "var(--fg-tertiary)" }}>superseded_by:</span>{" "}
                    <span style={{ color: "var(--exo-amber)" }}>
                      &quot;[[newer-constraint]]&quot;
                    </span>
                    {"\n"}
                    <span style={{ color: "var(--fg-tertiary)" }}>---</span>
                    {"\n\nBatch embeddings at 256 on 16 GB cards.\nReplaced after "}
                    <span style={{ color: "rgba(255,176,0,0.8)" }}>[[benchmark-run-014]]</span>
                    {" showed VRAM\nheadroom, not throughput, is the bound."}
                  </pre>
                </div>
                <p
                  style={{
                    margin: "14px 0 0",
                    fontSize: "13px",
                    fontWeight: 300,
                    lineHeight: 1.6,
                    color: "var(--fg-tertiary)",
                  }}
                >
                  Supersession lives in the file, not in a hidden database — grep it, diff it,
                  version it.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ============ 02 — CAPABILITIES ============ */}
        <section style={sectionBorder}>
          <div style={shell}>
            <p data-reveal style={label}>
              02 — Capabilities
            </p>
            <h2 data-reveal data-reveal-delay="80" style={h2}>
              The whole stack, local.
            </h2>
            <div
              style={{
                marginTop: "44px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,300px),1fr))",
                gap: "0 clamp(24px,3vw,48px)",
              }}
            >
              {capabilities.map((cap) => (
                <div
                  key={cap.num}
                  data-reveal
                  className="exo-cap"
                  style={{ padding: "20px 0 30px" }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: "14px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: MONO,
                        fontSize: "11px",
                        color: "var(--fg-tertiary)",
                      }}
                    >
                      {cap.num}
                    </span>
                    <h3
                      style={{
                        margin: 0,
                        fontFamily: MONO,
                        fontSize: "15px",
                        fontWeight: 500,
                        letterSpacing: "-0.01em",
                        color: "var(--fg-primary)",
                      }}
                    >
                      {cap.title}
                    </h3>
                  </div>
                  <p
                    style={{
                      margin: "10px 0 0",
                      paddingLeft: "33px",
                      fontSize: "0.9rem",
                      fontWeight: 300,
                      lineHeight: 1.65,
                      color: "var(--fg-secondary)",
                    }}
                  >
                    {cap.text}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============ 03 — MEASURED ============ */}
        <section style={sectionBorder}>
          <div style={shell}>
            <p data-reveal style={label}>
              03 — Measured at scale
            </p>
            <h2
              data-reveal
              data-reveal-delay="80"
              style={{ ...h2, maxWidth: "44rem", textWrap: "balance" }}
            >
              Sub-second at 50,000 notes — measured, not asserted.
            </h2>
            <p
              data-reveal
              data-reveal-delay="160"
              style={{
                margin: "22px 0 0",
                maxWidth: "38rem",
                fontSize: "1rem",
                fontWeight: 300,
                lineHeight: 1.7,
                color: "var(--fg-secondary)",
              }}
            >
              Most memory tools claim they scale. Exomem publishes the numbers — and the
              methodology, so you can reproduce them on your own vault.
            </p>
            <div
              style={{
                marginTop: "48px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))",
                gap: "1px",
                background: "rgba(236,233,226,0.09)",
                border: "1px solid rgba(236,233,226,0.09)",
                borderRadius: "12px",
                overflow: "hidden",
              }}
            >
              {benchmarks.map((b) => (
                <div
                  key={b.value}
                  data-reveal
                  style={{ background: "#0e0c0a", padding: "30px 28px 32px" }}
                >
                  <p
                    style={{
                      margin: 0,
                      fontFamily: MONO,
                      fontSize: "clamp(2rem,3.4vw,2.6rem)",
                      fontWeight: 500,
                      letterSpacing: "-0.03em",
                      lineHeight: 1,
                      color: b.color,
                    }}
                  >
                    {b.value}
                    <span
                      style={{
                        fontSize: "0.45em",
                        fontWeight: 400,
                        color: "var(--fg-tertiary)",
                        marginLeft: "8px",
                      }}
                    >
                      {b.unit}
                    </span>
                  </p>
                  <p
                    style={{
                      margin: "16px 0 0",
                      fontSize: "0.875rem",
                      fontWeight: 300,
                      lineHeight: 1.6,
                      color: "var(--fg-secondary)",
                    }}
                  >
                    {b.label}
                  </p>
                </div>
              ))}
            </div>
            <p
              data-reveal
              style={{
                margin: "24px 0 0",
                fontFamily: MONO,
                fontSize: "12px",
                lineHeight: 1.7,
                color: "var(--fg-tertiary)",
              }}
            >
              Reference desktop — Ryzen 7 5800X3D · RTX 5080 · 32 GB RAM.{" "}
              <a
                href="https://github.com/Artexis10/exomem/blob/main/docs/benchmarks.md"
                {...externalLink}
                className="exo-underline-sp"
              >
                See the methodology →
              </a>
            </p>
          </div>
        </section>

        {/* ============ 04 — THE DIFFERENCE ============ */}
        <section style={sectionBorder}>
          <div style={shell}>
            <p data-reveal style={label}>
              04 — The difference
            </p>
            <h2 data-reveal data-reveal-delay="80" style={{ ...h2, maxWidth: "44rem" }}>
              Your memory stays yours.
            </h2>
            <div
              style={{
                marginTop: "44px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))",
                gap: "clamp(16px,2vw,24px)",
              }}
            >
              <div
                data-reveal
                style={{
                  border: "1px solid rgba(236,233,226,0.08)",
                  borderRadius: "12px",
                  padding: "30px 28px",
                  background: "transparent",
                }}
              >
                <p
                  style={{
                    ...label,
                    fontSize: "11px",
                    letterSpacing: "0.16em",
                  }}
                >
                  Cloud memory services
                </p>
                <ul
                  style={{
                    margin: "22px 0 0",
                    padding: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: "14px",
                  }}
                >
                  {[
                    "Extract your data into a vector database or knowledge graph in their cloud",
                    "The memory is a derived copy — you never get plain files back",
                    "Account and subscription required; your data leaves your machine",
                  ].map((li) => (
                    <li
                      key={li}
                      style={{
                        display: "flex",
                        gap: "12px",
                        fontSize: "0.95rem",
                        fontWeight: 300,
                        lineHeight: 1.6,
                        color: "#8a8478",
                      }}
                    >
                      <span
                        aria-hidden="true"
                        style={{ color: "var(--fg-tertiary)", flex: "none" }}
                      >
                        –
                      </span>
                      {li}
                    </li>
                  ))}
                </ul>
              </div>

              <div
                data-reveal
                data-reveal-delay="120"
                style={{
                  position: "relative",
                  border: "1px solid rgba(255,176,0,0.22)",
                  borderRadius: "12px",
                  padding: "30px 28px",
                  background: "#100e0b",
                  boxShadow: "0 0 60px rgba(255,176,0,0.05)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    top: "-1px",
                    left: "24px",
                    right: "24px",
                    height: "1px",
                    background: "var(--exo-amber)",
                  }}
                />
                <p
                  style={{
                    margin: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    fontFamily: MONO,
                    fontSize: "11px",
                    fontWeight: 500,
                    letterSpacing: "0.16em",
                    textTransform: "uppercase",
                    color: "var(--exo-amber)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      background: "var(--exo-amber)",
                      display: "inline-block",
                    }}
                  />
                  Exomem
                </p>
                <ul
                  style={{
                    margin: "22px 0 0",
                    padding: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: "14px",
                  }}
                >
                  {[
                    "Plain Markdown in a vault you own — edit it anywhere, forever",
                    "The index is a local SQLite sidecar — the files themselves are the memory",
                    "Self-hosted, no account — with the lean install, nothing leaves your machine",
                  ].map((li) => (
                    <li
                      key={li}
                      style={{
                        display: "flex",
                        gap: "12px",
                        fontSize: "0.95rem",
                        fontWeight: 300,
                        lineHeight: 1.6,
                        color: "#c8c3b8",
                      }}
                    >
                      <span aria-hidden="true" style={{ color: "var(--exo-amber)", flex: "none" }}>
                        ▸
                      </span>
                      {li}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p
              data-reveal
              style={{
                margin: "28px 0 0",
                fontSize: "0.95rem",
                fontWeight: 300,
                color: "var(--fg-secondary)",
              }}
            >
              <Link href="/blog/exomem-vs-mem0-letta-zep" className="exo-underline-pp">
                Full comparison vs mem0, Letta, Zep, cognee, and Basic Memory →
              </Link>
              <br />
              <Link href="/blog/exomem-vs-claude-mem" className="exo-underline-pp">
                Exomem vs claude-mem: session continuity vs durable knowledge →
              </Link>
            </p>
          </div>
        </section>

        {/* ============ 05 — INSTALL ============ */}
        <section style={sectionBorder}>
          <div style={shell}>
            <p data-reveal style={label}>
              05 — Install
            </p>
            <div
              style={{
                marginTop: "28px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,340px),1fr))",
                gap: "clamp(24px,4vw,56px)",
                alignItems: "start",
                maxWidth: "64rem",
              }}
            >
              <div
                data-reveal
                data-reveal-delay="80"
                style={{
                  border: "1px solid var(--exo-border-card)",
                  borderRadius: "12px",
                  background: "var(--bg-panel)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "12px",
                    padding: "12px 18px",
                    borderBottom: "1px solid var(--exo-rule)",
                  }}
                >
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: "11px",
                      color: "var(--fg-tertiary)",
                    }}
                  >
                    terminal
                  </span>
                  <CopyButton variant="terminal" />
                </div>
                <div
                  style={{
                    padding: "20px 18px",
                    fontFamily: MONO,
                    fontSize: "13.5px",
                    lineHeight: 2,
                    color: "var(--fg-secondary)",
                  }}
                >
                  <p style={{ margin: 0 }}>
                    <span style={{ color: "var(--fg-tertiary)" }}>$ </span>pip install exomem
                  </p>
                  <p style={{ margin: 0 }}>
                    <span style={{ color: "var(--fg-tertiary)" }}>$ </span>exomem --help
                  </p>
                  <p style={{ margin: 0, color: "var(--fg-tertiary)" }}>
                    # extras: local embeddings · CLIP · OCR · ASR
                  </p>
                </div>
              </div>

              <div data-reveal data-reveal-delay="140">
                <p style={{ ...label, margin: "4px 0 0" }}>Works with</p>
                <div
                  style={{
                    marginTop: "18px",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: "10px",
                  }}
                >
                  {["Claude Code", "Claude Desktop", "Codex", "Cursor", "any MCP client"].map(
                    (chip) => (
                      <span
                        key={chip}
                        style={{
                          border: "1px solid var(--exo-border-input)",
                          borderRadius: "999px",
                          padding: "7px 15px",
                          fontFamily: MONO,
                          fontSize: "11.5px",
                          color: "var(--fg-secondary)",
                        }}
                      >
                        {chip}
                      </span>
                    )
                  )}
                </div>
                <p
                  style={{
                    margin: "22px 0 0",
                    maxWidth: "26rem",
                    fontSize: "13.5px",
                    fontWeight: 300,
                    lineHeight: 1.7,
                    color: "var(--fg-secondary)",
                  }}
                >
                  The same memory is also reachable from the CLI and a personal REST facade — all
                  generated from one operation registry.
                </p>
              </div>
            </div>
            <div
              data-reveal
              data-reveal-delay="160"
              style={{
                marginTop: "28px",
                display: "flex",
                flexWrap: "wrap",
                gap: "12px 32px",
                fontFamily: MONO,
                fontSize: "12.5px",
              }}
            >
              <a
                href="https://github.com/Artexis10/exomem"
                {...externalLink}
                className="exo-link-sp"
              >
                GitHub source →
              </a>
              <a href="https://pypi.org/project/exomem/" {...externalLink} className="exo-link-sp">
                PyPI package →
              </a>
              <a
                href="https://github.com/Artexis10/exomem/blob/main/README.md"
                {...externalLink}
                className="exo-link-sp"
              >
                README →
              </a>
            </div>
          </div>
        </section>

        {/* ============ 06 — HOSTED ============ */}
        <section style={sectionBorder}>
          <div style={shell}>
            <div
              data-reveal
              style={{
                maxWidth: "44rem",
                margin: "0 auto",
                border: "1px solid var(--exo-border-card)",
                borderRadius: "12px",
                padding: "clamp(28px,4vw,44px)",
                background: "#0e0c0a",
              }}
            >
              <p style={label}>06 — Exomem Hosted</p>
              <h2
                style={{
                  ...h2,
                  margin: "20px 0 0",
                  fontSize: "clamp(1.3rem,2.4vw,1.7rem)",
                  lineHeight: 1.3,
                  letterSpacing: "-0.02em",
                }}
              >
                Hosted Exomem is a friends-only private alpha.
              </h2>
              <p
                style={{
                  margin: "18px 0 0",
                  fontSize: "0.95rem",
                  fontWeight: 300,
                  lineHeight: 1.7,
                  color: "var(--fg-secondary)",
                }}
              >
                Self-hosted Exomem stays the full open-source product you run yourself. Hosted runs
                it for a small friends cohort while we finish the v1 alpha. Tenant cells process
                plaintext for search; storage and transport are encrypted. Express interest below;
                invitations are personally issued and there is no public checkout.
              </p>
              <p
                style={{
                  margin: "16px 0 0",
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "6px 10px",
                  fontFamily: MONO,
                  fontSize: "11.5px",
                  lineHeight: 1.6,
                  color: "var(--fg-tertiary)",
                }}
              >
                <span>friends-only v1 alpha</span>
                <span aria-hidden="true">·</span>
                <span>your data exportable any time</span>
                <span aria-hidden="true">·</span>
                <Link href="/exomem/setup" className="exo-link-ts">
                  Self-hosted setup →
                </Link>
              </p>
              <HostedAccessForm />
            </div>
          </div>
        </section>

        {/* ============ 07 — FAQ ============ */}
        <section style={sectionBorder}>
          <div style={{ ...shell, maxWidth: "48rem" }}>
            <p data-reveal style={label}>
              07 — FAQ
            </p>
            <h2 data-reveal data-reveal-delay="80" style={h2}>
              Common questions
            </h2>
            <FaqAccordion items={displayFaqs} />
          </div>
        </section>
      </main>

      {/* ============ FOOTER ============ */}
      <footer style={sectionBorder}>
        <div
          style={{
            maxWidth: "72rem",
            margin: "0 auto",
            padding: "56px clamp(20px,5vw,48px)",
            display: "flex",
            flexWrap: "wrap",
            gap: "24px 48px",
            alignItems: "baseline",
            justifyContent: "space-between",
          }}
        >
          <div>
            <p
              style={{
                margin: 0,
                fontFamily: MONO,
                fontSize: "13px",
                fontWeight: 500,
                color: "var(--fg-primary)",
              }}
            >
              exomem
            </p>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: "12px",
                fontWeight: 300,
                color: "var(--fg-tertiary)",
              }}
            >
              © 2026 Substrate Systems OÜ · AGPL-3.0
            </p>
          </div>
          <nav
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "12px 28px",
              fontSize: "12.5px",
              fontWeight: 300,
            }}
          >
            <Link href="/" className="exo-link-ts">
              Substrate
            </Link>
            <Link href="/endstate" className="exo-link-ts">
              Endstate
            </Link>
            <a href="https://github.com/Artexis10/exomem" {...externalLink} className="exo-link-ts">
              Exomem source
            </a>
            <a href="https://pypi.org/project/exomem/" {...externalLink} className="exo-link-ts">
              PyPI
            </a>
            <Link href="/exomem/privacy" className="exo-link-ts">
              Privacy
            </Link>
            <Link href="/exomem/terms" className="exo-link-ts">
              Terms
            </Link>
            <Link href="/exomem/support" className="exo-link-ts">
              Support
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
