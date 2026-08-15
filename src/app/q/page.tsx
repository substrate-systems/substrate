import Link from "next/link";
import Footer from "@/components/Footer";

// Substrate-side entity page for Q. Deliberately not a second marketing site:
// useq.ai owns the product narrative, conversion, and FAQ (its FAQPage JSON-LD must
// match its own visible copy, so none of it is restated here).

const facts: { term: string; detail: React.ReactNode }[] = [
  { term: "Type", detail: "Hosted, multi-tenant web platform" },
  { term: "Source", detail: "Proprietary — the only closed-source product in the portfolio" },
  {
    term: "Built by",
    detail: (
      <>
        Substrate Systems OÜ, founded by{" "}
        <Link href="/work" className="underline underline-offset-4 hover:text-fg-primary">
          Hugo Ander Kivi
        </Link>
      </>
    ),
  },
  { term: "Availability", detail: "Early access, by conversation — no self-serve signup" },
  {
    term: "Product site",
    detail: (
      <a
        href="https://useq.ai"
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-4 hover:text-fg-primary"
      >
        useq.ai ↗
      </a>
    ),
  },
];

export default function QPage() {
  return (
    <main className="min-h-screen bg-bg-base">
      <section className="mx-auto w-full max-w-3xl px-6 pt-32 pb-20 sm:pt-40">
        <Link
          href="/"
          className="text-xs uppercase tracking-[0.2em] text-fg-tertiary transition-colors hover:text-fg-secondary"
        >
          ← Substrate
        </Link>

        <h1 className="mt-12 text-4xl font-light tracking-tight text-fg-primary sm:text-5xl">Q</h1>

        <p className="mt-6 text-xl font-light leading-relaxed text-fg-secondary sm:text-2xl">
          Source-grounded AI for content libraries. Q ingests the video, audio, and documents a
          creator or company has already produced, then answers questions from that material — and
          cites the exact moment it came from.
        </p>

        <p className="mt-6 text-lg font-light leading-relaxed text-fg-secondary">
          The problem it solves is repetition. People with deep back catalogues answer the same
          questions endlessly, while the answer already exists somewhere in an old episode, talk, or
          document. Q makes that archive answerable on the owner&rsquo;s own domain and under their
          own brand, with every answer carrying a citation back to the source it came from.
        </p>
      </section>

      <section className="mx-auto w-full max-w-3xl border-t border-border-subtle px-6 py-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">How it works</h2>
        <ul className="mt-8 space-y-6 text-lg font-light leading-relaxed text-fg-secondary">
          <li>
            <strong className="font-normal text-fg-primary">Ingest.</strong> Long-form video,
            podcasts, and documents are transcribed and segmented into searchable passages.
          </li>
          <li>
            <strong className="font-normal text-fg-primary">Retrieve.</strong> Semantic search runs
            over those passages. Embeddings are computed on Substrate&rsquo;s own infrastructure
            using local models rather than a third-party embedding API.
          </li>
          <li>
            <strong className="font-normal text-fg-primary">Answer with receipts.</strong> Responses
            are generated from retrieved passages and linked back to the source, so a reader can
            jump to the original moment and check it.
          </li>
          <li>
            <strong className="font-normal text-fg-primary">Serve under your brand.</strong> Each
            tenant gets an isolated, branded surface with domain routing and subscriber
            authentication.
          </li>
        </ul>
        <p className="mt-8 text-base font-light leading-relaxed text-fg-tertiary">
          The answer layer routes through whichever model a tenant selects, currently defaulting to
          Anthropic&rsquo;s Claude family. How content is handled for training or retention depends
          on that provider, so Q does not make a blanket promise on its behalf.
        </p>
      </section>

      <section className="mx-auto w-full max-w-3xl border-t border-border-subtle px-6 py-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">Status</h2>
        <p className="mt-8 text-lg font-light leading-relaxed text-fg-secondary">
          Q runs in production today. A flagship long-form video tenant is live, with a corpus of
          more than 1,300 indexed sources. Onboarding is currently operator-led rather than
          self-serve: there is no public signup and no published price list. Early access starts
          with a conversation about library size and audience model.
        </p>
        <p className="mt-8 text-lg font-light text-fg-secondary">
          <a
            href="mailto:hello@useq.ai"
            className="underline underline-offset-4 hover:text-fg-primary"
          >
            hello@useq.ai
          </a>
          <span className="text-fg-tertiary"> · </span>
          <a
            href="https://useq.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-fg-primary"
          >
            useq.ai ↗
          </a>
        </p>
      </section>

      <section className="mx-auto w-full max-w-3xl border-t border-border-subtle px-6 py-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">At a glance</h2>
        <dl className="mt-8 space-y-5">
          {facts.map((fact) => (
            <div key={fact.term} className="flex flex-wrap gap-x-6 gap-y-1">
              <dt className="w-32 shrink-0 text-sm text-fg-tertiary">{fact.term}</dt>
              <dd className="text-lg font-light text-fg-secondary">{fact.detail}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto w-full max-w-3xl border-t border-border-subtle px-6 py-16">
        <h2 className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
          Other Substrate products
        </h2>
        <div className="mt-8 space-y-6 text-lg font-light leading-relaxed text-fg-secondary">
          <p>
            <Link
              href="/endstate"
              className="text-fg-primary underline underline-offset-4 hover:text-white"
            >
              Endstate
            </Link>{" "}
            — capture a machine&rsquo;s apps and settings to one portable file, then restore them on
            a fresh install. Free and open source.
          </p>
          <p>
            <Link
              href="/exomem"
              className="text-fg-primary underline underline-offset-4 hover:text-white"
            >
              Exomem
            </Link>{" "}
            — durable, MCP-native memory for AI agents over a Markdown vault you own. Open source.
          </p>
        </div>
      </section>

      <Footer />
    </main>
  );
}
