import Link from "next/link";
import { buildMetadata, siteConfig } from "@/lib/seo";
import { ExomemPublicPage } from "../public-page";

export const metadata = buildMetadata({
  title: "How Exomem Benchmarks Memory Systems",
  description:
    "The fairness rules Exomem commits to before publishing any comparative benchmark number: competitor-authored configuration, guest posture on the competitor's own harness, per-knob provenance, and independent adversarial review before publication.",
  path: "/exomem/benchmarks",
  ogImage: "/exomem/og",
});

const CONTRACT_URL =
  "https://github.com/Artexis10/exomem/blob/main/docs/benchmark-fairness-contract.md";

// Published as a method page, deliberately ahead of results. The comparative
// programme is mid-rebuild after its own audit rejected the first head-to-head;
// pre-committing the rules is what will make the eventual numbers worth reading.
const rules: { title: string; body: string }[] = [
  {
    title: "Competitor configuration is competitor-authored",
    body: "Every configuration value applied to another product traces to that product's own code, by file and line, or to its published documentation, by URL. A setting without provenance refuses to run rather than running on our judgement of what is fair.",
  },
  {
    title: "We run as a guest, on their harness",
    body: "Head-to-head rows come from the competitor's own benchmark suite, with Exomem entered as a guest provider. We author only our own integration — the same posture any vendor takes on someone else's public suite.",
  },
  {
    title: "One reader, one judge, one ledger",
    body: "Answer and evaluation stages from a competitor's harness are never republished as-is. Retrieval artifacts are exported and re-judged under a single frozen reader, so a difference in scores cannot hide inside a difference in prompts or judges. Where a suite excludes failed questions from its accuracy figure, we count them.",
  },
  {
    title: "Our own glue is disclosed and measured",
    body: "Whatever we did write for a row — projectors, drivers, exporters — is accounted for by file, line count and endpoint. If our integration is substantially larger than a competitor's, that asymmetry is itself reported rather than quietly enjoyed.",
  },
  {
    title: "Harness faults are never contender losses",
    body: "An unreachable service, a model that failed to load, an index that was never built: these invalidate the row for every product equally. The previous programme published a competitor scoring zero while its embedding model had silently failed to download. That outcome is now structurally forbidden.",
  },
  {
    title: "Readiness is proven, not assumed",
    body: "An exit code is not evidence. Each product has a named verification method — vector-chunk counts and a log line, a terminal document status plus a canary, doctor checks that refuse rather than degrade. Where a product's default mode genuinely offers no completion signal, the row is marked unverifiable and disclosed, because invalidating a product's default mode would be its own bias.",
  },
  {
    title: "The plan is fixed before the run, and changes leave a trail",
    body: "Scenario families, assertions and acceptance thresholds are ratified before any competitor runs. Ratification leaves the approved bytes unchanged and adds an immutable receipt. Later changes are ordered amendments — mutation, omission, reordering and branch substitution all refuse.",
  },
  {
    title: "Independent adversarial review before publication",
    body: "An auto-generated packet of assumptions, confounds and suspicious-win flags goes to a reviewer with no stake in the outcome, and every material objection is either fixed or published beside the claim. A result showing a competitor ahead is a valid, publishable outcome of this programme.",
  },
];

export default function ExomemBenchmarksPage() {
  const articleJsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: "How Exomem benchmarks memory systems",
    description:
      "The fairness rules Exomem commits to before publishing any comparative benchmark number.",
    author: { "@type": "Organization", name: siteConfig.name, url: siteConfig.url },
    publisher: {
      "@type": "Organization",
      name: siteConfig.name,
      logo: {
        "@type": "ImageObject",
        url: `${siteConfig.url}/brand/logos/substrate-logo-dark.png`,
      },
    },
    mainEntityOfPage: `${siteConfig.url}/exomem/benchmarks`,
    image: [`${siteConfig.url}/exomem/og`],
    isBasedOn: CONTRACT_URL,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <ExomemPublicPage
        title="How we benchmark memory systems"
        eyebrow="Benchmark fairness contract"
      >
        <p>
          Almost every benchmark comparing AI memory systems is published by one of the
          products being compared, and configured by them too. That is not usually fraud. It
          is that tuning your own system well and a competitor&rsquo;s system adequately is
          the natural outcome of knowing one of them properly.
        </p>
        <p>
          This page is the set of rules Exomem commits to <em>before</em> publishing any
          comparative number. It is deliberately published ahead of results, because rules
          announced after the fact are worth very little.
        </p>

        <h2>Why this exists</h2>
        <p>
          On 31 July 2026 this project published head-to-head findings against Basic Memory.
          On 8 August an independent adversarial review rejected them, and on 9 August every
          cross-product figure in that document was withdrawn — not caveated, withdrawn.
        </p>
        <p>The defects ran in both directions, including ones that flattered us:</p>
        <ul>
          <li>
            The competitor&rsquo;s vector index was never built, so every figure recorded
            for it before that date measured a system that was not working.
          </li>
          <li>
            After that was fixed, the harness was found feeding the competitor hundreds of
            oracle-normalised fact lines phrased in the query&rsquo;s own vocabulary — an
            advantage no real deployment would have.
          </li>
          <li>
            Knowledge time was never transmitted to either system, provenance and abstention
            were authored by the shared answerer rather than by the products, and the run
            profile de-tuned Exomem&rsquo;s own defaults.
          </li>
        </ul>
        <p>
          Findings about Exomem alone survived that review — the product defects it exposed
          were real, and were fixed. The comparisons did not survive, and no replacement has
          been published yet. This contract exists so that the defect class that produced
          them is structurally impossible rather than merely discouraged.
        </p>

        <h2>The one-line rule</h2>
        <p>
          <strong>
            Competitor-side configuration is competitor-authored, or it does not run.
          </strong>
        </p>

        <h2>What that means in practice</h2>
        {/* An ordered list, not h3 blocks: `exo-prose` styles direct children only, so
            wrapped headings render as undifferentiated body text. These are numbered
            rules in the source contract, so a list is also the more accurate shape. */}
        <ol>
          {rules.map((rule) => (
            <li key={rule.title}>
              <strong>{rule.title}.</strong> {rule.body}
            </li>
          ))}
        </ol>

        <h2>What is not here yet</h2>
        <p>
          Results. The comparative programme is being rebuilt under these rules, and
          publishing numbers before that work is finished would repeat exactly the mistake
          this page documents. When comparative figures appear, they will arrive with the
          per-row fairness matrix — configuration provenance, who authored each knob,
          enumerated asymmetries and the direction each one favours, readiness evidence,
          version and dataset pins, and any measurement that was blocked, with the reason.
        </p>
        <p>
          The full contract, including the reviewer&rsquo;s checklist of what to attack
          first, is maintained in the open-source repository and is the normative version of
          this page.
        </p>
        <p>
          <a href={CONTRACT_URL} target="_blank" rel="noopener noreferrer">
            Read the full fairness contract on GitHub ↗
          </a>
        </p>
        <p>
          Exomem itself is an open-source, MCP-native memory server over a Markdown vault you
          own — see <Link href="/exomem">the product page</Link>, or the honest comparisons
          with{" "}
          <Link href="/blog/exomem-vs-mem0-letta-zep">mem0, Letta, Zep and Basic Memory</Link>{" "}
          and <Link href="/blog/exomem-vs-claude-mem">claude-mem</Link>, which are written
          from published behaviour rather than from benchmark runs.
        </p>
      </ExomemPublicPage>
    </>
  );
}
