import type { ReactNode } from "react";
import Link from "next/link";
import { breadcrumbJsonLd, siteConfig } from "@/lib/seo";
import { buildExomemMetadata } from "@/lib/exomem/metadata";
import { DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS } from "@/lib/exomem-hosted/cloud-config";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { ButtonLink } from "@/components/exomem/Button";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { Wordmark } from "@/components/exomem/Wordmark";
import { CLIENT_FAMILY_NAMES } from "@/lib/exomem-hosted/client-platforms";
import phone from "@/components/exomem/phone.module.css";
import { HeroPanel } from "./landing/HeroPanel";
import { ConnectDrawing, EvolveDrawing, LivingMap, RememberDrawing } from "./landing/Illustrations";
import { PipInstall } from "./landing/PipInstall";
import { proofFigures } from "./landing/proof";
import recallBenchmarks from "./landing/recall-benchmarks.json";
import responsive from "./landing/responsive.module.css";
import styles from "./landing/landing.module.css";

const HERO_TEXT =
  "Exomem is the knowledge base all your assistants share. Claude, ChatGPT, Claude Code, Codex and every session you connect read from it and add to it. When something changes, it keeps what was true, why it changed and what replaced it, as plain Markdown you own.";

// The phone lede; its first two sentences are also the page's search description.
const PHONE_LEDE_START =
  "The knowledge base all your assistants share, in every session. When something changes, Exomem keeps what was true, why it changed and what replaced it";
const proof = proofFigures(recallBenchmarks);

export const metadata = buildExomemMetadata({
  // Retargeted 2026-07-25 against measured demand: "mcp memory server" (KD 22) and
  // "markdown knowledge base" (KD 8) are both reachable at this domain's authority,
  // where "agent memory" (KD 33+) is not. Kept to 60 characters — the site audit
  // flagged over-long titles elsewhere.
  title: "Exomem — MCP memory server over your Markdown knowledge base",
  description: `${PHONE_LEDE_START}.`,
  path: "/exomem",
});

const GITHUB = "https://github.com/Artexis10/exomem";
const PYPI = "https://pypi.org/project/exomem/";
const README = `${GITHUB}#readme`;
const SIGN_IN = "/exomem/sign-in";
const START = "Start with your email →";
const ASSISTANTS = Object.entries(CLIENT_FAMILY_NAMES)
  .filter(([family]) => family !== "other")
  .map(([, name]) => name);

const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Exomem",
  applicationCategory: "DeveloperApplication",
  operatingSystem: "Windows, macOS, Linux",
  description: `Open-source MCP memory server over a Markdown knowledge base you own — a plain folder or an Obsidian vault. Hybrid keyword and vector retrieval, sub-second at ${proof.scaleNotes} notes, measured, with local OCR, ASR, and image indexing.`,
  url: `${siteConfig.url}/exomem`,
  downloadUrl: PYPI,
  installUrl: PYPI,
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
  license: `${GITHUB}/blob/main/LICENSE`,
  sameAs: [GITHUB, PYPI],
  // SoftwareApplication does not carry `codeRepository` or `programmingLanguage`; both
  // belong to SoftwareSourceCode, and emitting them here invalidated the entire item.
  isBasedOn: {
    "@type": "SoftwareSourceCode",
    name: "Exomem",
    description:
      "Open-source MCP server exposing a Markdown or Obsidian vault as a governed, searchable knowledge substrate.",
    codeRepository: GITHUB,
    programmingLanguage: "Python",
    license: "https://www.gnu.org/licenses/agpl-3.0.html",
  },
};

const breadcrumb = breadcrumbJsonLd([
  { name: "Home", path: "/" },
  { name: "Exomem", path: "/exomem" },
]);

const external = { target: "_blank", rel: "noopener noreferrer" } as const;

/** Copy the boards word differently on desktop and on a phone. */
function Copy({ desk, phone: onPhone }: { desk: ReactNode; phone: ReactNode }) {
  return (
    <>
      <span className={responsive.deskOnly}>{desk}</span>
      <span className={responsive.phoneOnly}>{onPhone}</span>
    </>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className={styles.eyebrow}>{children}</div>;
}

function Assistants() {
  return (
    <div className={styles.chips}>
      {ASSISTANTS.map((name) => (
        <span key={name} className={styles.chip}>
          {name}
        </span>
      ))}
      <span
        className={`${styles.chip} ${styles.anyApp}`}
        title="Any app or agent that supports MCP"
      >
        + any MCP app
      </span>
    </div>
  );
}

function days(count: number): string {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

export default function ExomemPage() {
  const kept = days(DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS);

  const proofCells = [
    { value: proof.recall, caption: "to recall from a real vault" },
    { value: proof.scaleNotes, caption: "notes, still under a second" },
    {
      value: "1",
      caption: (
        <Copy
          desk="knowledge base for every assistant and session you connect"
          phone="knowledge base for every assistant and session"
        />
      ),
    },
    { value: ".md", caption: "plain Markdown you own" },
  ];

  const pillars = [
    {
      title: "Remember",
      drawing: <RememberDrawing />,
      desk: "Every assistant you connect reads from it and adds to it. Ask in your own words; decisions, sources and what you learned are kept, not lost when the chat ends.",
      phone:
        "Every assistant you connect reads from it and adds to it. What you decided and learned is kept, not lost when the chat ends.",
    },
    {
      title: "Connect",
      drawing: <ConnectDrawing />,
      desk: "Notes link by what they mean: this supports that, this contradicts that. Contradictions come up for review instead of one answer quietly winning.",
      phone:
        "Notes link by what they mean: this supports that, this contradicts that. Contradictions come up for review.",
    },
    {
      title: "Evolve",
      drawing: <EvolveDrawing />,
      desk: "Nothing is thrown away. When you change your mind, the old note is superseded and kept, so you can still ask what you knew in March, and why.",
      phone:
        "Nothing is thrown away. The old note is superseded and kept, so you can still ask what you knew in March, and why.",
    },
  ];

  // Promised only while Home offers the export (design.md deviation (s)). This page is
  // static, so it reads the flag at build, and a flag change takes a deploy.
  const exportOffered = cloudExportsEnabled();

  const cloudSteps = [
    { desk: "Start with your email; no password", phone: "Start with your email" },
    { desk: "Subscribe; your vault is ready in a minute", phone: "Subscribe; ready in a minute" },
    {
      desk: "Add Exomem in Claude’s connectors or ChatGPT’s plugins",
      phone: "Add it to Claude or ChatGPT",
    },
  ];

  const promises = [
    {
      desk: "Storage and transport encrypted; each account’s vault runs in its own cell",
      phone: "Encrypted, in its own cell",
    },
    {
      desk: "If a payment fails, memory turns read-only while Paddle retries. Nothing is lost.",
      phone: "Payment fails? Read-only while Paddle retries. Nothing lost.",
    },
    {
      desk: `If you cancel, we keep everything for ${kept}, read-only, then delete it.`,
      phone: `Cancel, and we keep it ${kept}, read-only.`,
    },
    ...(exportOffered
      ? [
          {
            desk: "Export a verified copy of your vault any time, in any state.",
            phone: "Export a verified copy any time.",
          },
        ]
      : []),
  ];

  // The phone board's footer, in its order; the desktop board draws none (design.md (x)).
  const footerLinks = [
    { label: "How it works", href: "#lp-true" },
    { label: "Benchmarks", href: "#lp-proof" },
    { label: "Pricing", href: "#lp-doors" },
    { label: "Privacy", href: "/exomem/privacy" },
    { label: "Terms", href: "/exomem/terms" },
    { label: "Support", href: "/exomem/support" },
    { label: "GitHub", href: GITHUB, external: true },
  ];

  return (
    <div className={`brand-exomem ${styles.page}`}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumb) }}
      />

      <div className={styles.main}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={`${styles.wordmark} ${responsive.deskOnly}`}>
              <Wordmark height={17} />
            </span>
            <span className={`${styles.wordmark} ${responsive.phoneOnly}`}>
              <Wordmark height={17} />
            </span>
            <Link href="/" className={`exo-link-ts ${styles.byline} ${responsive.deskOnly}`}>
              by Substrate Systems
            </Link>
          </div>
          <nav className={styles.nav} aria-label="Exomem">
            <a
              href="#lp-true"
              className={`exo-link-ts ${styles.sectionLink} ${responsive.deskOnly}`}
            >
              How it works
            </a>
            <a
              href="#lp-proof"
              className={`exo-link-ts ${styles.sectionLink} ${responsive.deskOnly}`}
            >
              Benchmarks
            </a>
            <a
              href="#lp-cloud"
              className={`exo-link-ts ${styles.sectionLink} ${responsive.deskOnly}`}
            >
              Cloud
            </a>
            <a
              href={GITHUB}
              {...external}
              className={`exo-link-ts ${styles.sectionLink} ${responsive.deskOnly}`}
            >
              GitHub
            </a>
            <ThemeToggle />
            <Link href={SIGN_IN} className={`exo-link-ts ${styles.signIn}`}>
              Sign in
            </Link>
          </nav>
        </header>

        {/* data-sec names each section as the Landing-Page board does, so design QA can
            match the page to the prototype section by section. */}
        <main>
          <section className={styles.hero} data-sec="hero">
            <div className={styles.heroCopy}>
              <Eyebrow>
                <Copy
                  desk="An epistemic knowledge base, built around you"
                  phone="An epistemic knowledge base"
                />
              </Eyebrow>
              <h1 className={styles.display}>
                Grows with you.
                <br />
                Stays true.
              </h1>
              <p className={styles.lede}>
                <Copy desk={HERO_TEXT} phone={`${PHONE_LEDE_START}, as plain Markdown you own.`} />
              </p>
              <div className={styles.heroActions}>
                <div className={styles.heroCtas}>
                  <ButtonLink href={SIGN_IN} variant="primary" size="landing">
                    {START}
                  </ButtonLink>
                  <span className={responsive.deskOnly}>
                    <PipInstall look="hero" />
                  </span>
                  <a
                    href="#lp-doors"
                    className={`exo-link-ts ${styles.runLink} ${responsive.phoneOnly}`}
                  >
                    Run it yourself, free →
                  </a>
                </div>
                <Assistants />
              </div>
            </div>
            <HeroPanel latency={proof.heroLatency} />
          </section>

          <section id="lp-proof" className={styles.proof} data-sec="proof">
            {proofCells.map(({ value, caption }) => (
              <div key={value} className={styles.proofCell}>
                <span className={styles.proofValue}>{value}</span>
                <span className={styles.proofCaption}>{caption}</span>
              </div>
            ))}
          </section>

          <section id="lp-true" className={`${styles.section} ${styles.pillars}`} data-sec="true">
            <Eyebrow>01 · How it stays true</Eyebrow>
            <h2 className={styles.h2}>Built to change without forgetting.</h2>
            <div className={styles.pillarGrid}>
              {pillars.map(({ title, drawing, desk, phone: onPhone }, index) => (
                <div key={title} className={styles.pillar}>
                  {drawing}
                  <div className={styles.pillarTitle}>
                    <span className={styles.pillarNumber}>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3>{title}</h3>
                  </div>
                  <p className={styles.body}>
                    <Copy desk={desk} phone={onPhone} />
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section
            id="lp-viewer"
            className={`${styles.section} ${styles.viewer}`}
            data-sec="viewer"
          >
            <div className={styles.viewerCopy}>
              <Eyebrow>02 · See it</Eyebrow>
              <h2 className={`${styles.h2} ${styles.viewerTitle}`}>
                Your knowledge, as a living map.
              </h2>
              <p className={styles.body}>
                <Copy
                  desk="In your Exomem account: click any note to see what supports it, what it replaced and where it came from. Scrub back in time. Watch your assistants recall, live."
                  phone="Click any note to see what supports it and what it replaced. Scrub back in time. Watch your assistants recall, live."
                />
              </p>
            </div>
            <div className={styles.frame}>
              <LivingMap />
            </div>
          </section>

          <section
            id="lp-doors"
            className={`${styles.section} ${styles.doorsSection}`}
            data-sec="doors"
          >
            <Eyebrow>03 · Two ways in</Eyebrow>
            <h2 className={`${styles.h2} ${styles.doorsTitle}`}>
              Use it in your assistant, or run it yourself.
            </h2>
            <div className={styles.doors}>
              <div className={`${styles.door} ${styles.cloudDoor}`}>
                <div className={styles.doorHead}>
                  <h3>In your assistant</h3>
                  <span className={`${styles.tag} ${styles.cloudTag}`}>
                    <Copy desk="hosted" phone="Cloud" />
                  </span>
                </div>
                <ol className={styles.steps}>
                  {cloudSteps.map(({ desk, phone: onPhone }, index) => (
                    <li key={desk} className={styles.step}>
                      <span className={styles.stepNumber}>{index + 1}</span>
                      <Copy desk={desk} phone={onPhone} />
                    </li>
                  ))}
                </ol>
                <div className={responsive.deskOnly}>
                  <Assistants />
                </div>
                <div className={`${styles.doorCta} ${responsive.phoneOnly}`}>
                  <ButtonLink href={SIGN_IN} variant="primary" size="landing">
                    {START}
                  </ButtonLink>
                </div>
                <div className={styles.doorNote}>
                  <Copy
                    desk={`Monthly · cancel any time${exportOffered ? " · export whenever you like" : ""}`}
                    phone={`Monthly · cancel any time${exportOffered ? " · export any time" : ""}`}
                  />
                </div>
              </div>
              <div className={styles.door}>
                <div className={styles.doorHead}>
                  <h3>Run it yourself</h3>
                  <span className={styles.tag}>open source</span>
                </div>
                <div className={styles.tagline}>
                  <Copy
                    desk="Agents get memory. You keep the files."
                    phone={
                      <>
                        Agents get memory.
                        <br />
                        You keep the files.
                      </>
                    }
                  />
                </div>
                <PipInstall look="door" />
                <div className={`${styles.doorText} ${responsive.deskOnly}`}>
                  Open source. Runs on your machine with any MCP client, Cursor included.
                </div>
                <div className={styles.sourceLinks}>
                  <a href={GITHUB} {...external} className={`exo-link-ts ${phone.hitArea}`}>
                    GitHub
                  </a>
                  {" · "}
                  <a href={PYPI} {...external} className={`exo-link-ts ${phone.hitArea}`}>
                    PyPI
                  </a>
                  {" · "}
                  <a href={README} {...external} className={`exo-link-ts ${phone.hitArea}`}>
                    README
                  </a>
                </div>
              </div>
            </div>
          </section>

          <section id="lp-cloud" className={`${styles.section} ${styles.cloud}`} data-sec="cloud">
            <div className={styles.cloudCopy}>
              <Eyebrow>04 · Yours to keep</Eyebrow>
              <h2 className={`${styles.h2} ${styles.cloudTitle}`}>We run it. You own it.</h2>
              <p className={`${styles.cloudLede} ${responsive.deskOnly}`}>
                The same open-source engine, hosted for you. Your vault is plain Markdown
                {exportOffered
                  ? ", and you can export it any time, even after you stop paying"
                  : ""}
                .
              </p>
              <div className={styles.cloudCta}>
                <ButtonLink href={SIGN_IN} variant="primary" size="landing">
                  {START}
                </ButtonLink>
              </div>
            </div>
            <ol className={styles.promises}>
              {promises.map(({ desk, phone: onPhone }, index) => (
                <li key={desk} className={styles.promise}>
                  <span className={styles.promiseNumber}>{String(index + 1).padStart(2, "0")}</span>
                  <Copy desk={desk} phone={onPhone} />
                </li>
              ))}
            </ol>
          </section>

          <section className={styles.developers} data-sec="stays">
            <Link href="/exomem/benchmarks" className={styles.developersLink}>
              <span className={styles.developersCopy}>
                <span className={styles.developersTitle}>For developers</span>
                <span className={styles.developersText}>
                  <Copy
                    desk="How it works inside, the full benchmarks and methodology, and how it compares."
                    phone="Internals, benchmarks, comparison"
                  />
                </span>
              </span>
              <span className={styles.developersAction}>
                <Copy desk="Read the details →" phone="→" />
              </span>
            </Link>
          </section>
        </main>

        <footer className={styles.footer}>
          <span className={styles.wordmark}>
            <Wordmark height={15} />
          </span>
          <nav className={styles.footerLinks} aria-label="Exomem pages">
            {footerLinks.map(({ label, href, external: isExternal }) =>
              href.startsWith("/") ? (
                <Link key={label} href={href} className={`exo-link-ts ${phone.hitArea}`}>
                  {label}
                </Link>
              ) : (
                <a
                  key={label}
                  href={href}
                  className={`exo-link-ts ${phone.hitArea}`}
                  {...(isExternal ? external : {})}
                >
                  {label}
                </a>
              )
            )}
          </nav>
          <span className={styles.copyright}>
            © {new Date().getFullYear()} Substrate Systems OÜ
          </span>
        </footer>
      </div>
    </div>
  );
}
