import { c } from "../_palette";
import { EndstateFooter, Nav } from "../_shared";

/**
 * Integration sponsorship.
 *
 * Intake deliberately reuses the existing contact path — a structured mailto to
 * founder@ — rather than a form, an API route, or a table. There is no
 * marketplace, no pooled funding, no bounty ledger, and no public price: scope
 * is decided in a conversation, so the call to action is a quote request.
 */

const INTAKE_FIELDS = [
  "Application name:",
  "Vendor and product URL:",
  "Version or edition:",
  "Current operating system:",
  "Installation source or package identity (winget ID, Chocolatey ID, MSI, vendor installer):",
  "Settings or state that must survive migration:",
  "May this integration be public? (yes / no):",
  "Deadline or business context:",
  "Contact name:",
  "Contact email:",
];

const INTAKE_MAILTO =
  "mailto:founder@substratesystems.io" +
  `?subject=${encodeURIComponent("Integration sponsorship enquiry — Endstate")}` +
  `&body=${encodeURIComponent(
    [
      "Hello Hugo,",
      "",
      "I would like a quote for sponsoring an Endstate integration.",
      "",
      ...INTAKE_FIELDS,
      "",
      "Thanks,",
    ].join("\n")
  )}`;

function P({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: "1rem", lineHeight: 1.75, color: c.textSec, marginBottom: "1.25rem" }}>
      {children}
    </p>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li
      className="flex gap-3"
      style={{ fontSize: "0.95rem", lineHeight: 1.65, color: c.textSec, marginBottom: "0.65rem" }}
    >
      <span aria-hidden style={{ color: c.teal, flexShrink: 0 }}>
        —
      </span>
      <span>{children}</span>
    </li>
  );
}

export default function SponsorAnIntegrationPage() {
  return (
    <>
      <main
        style={{
          fontFamily: "var(--font-dm-sans), -apple-system, sans-serif",
          background: c.bg,
          minHeight: "100vh",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <Nav />

        <section className="pt-32 sm:pt-40 pb-20 sm:pb-28 px-6" data-commercial-hero>
          <div
            className="mx-auto grid gap-8 lg:grid-cols-[1.2fr_0.8fr] lg:items-end"
            style={{ maxWidth: 1100 }}
          >
            <div style={{ maxWidth: 760 }}>
              <p
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  color: c.copper,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: "1.5rem",
                }}
              >
                Sponsor an integration
              </p>
              <h1
                style={{
                  fontSize: "clamp(2.4rem, 5.5vw, 4.4rem)",
                  fontWeight: 700,
                  lineHeight: 1.05,
                  letterSpacing: "-0.05em",
                  color: c.text,
                  marginBottom: "1.5rem",
                }}
              >
                Fund migration support for the application you depend on
              </h1>
              <p
                style={{
                  fontSize: "1.125rem",
                  lineHeight: 1.7,
                  color: c.textSec,
                  marginBottom: "2rem",
                }}
              >
                Endstate already reinstalls applications through WinGet and Chocolatey. Integration
                sponsorship funds deeper migration support: safe settings capture and restore,
                version handling, package-identity edge cases, testing, and documentation.
              </p>
              <a
                href={INTAKE_MAILTO}
                className="inline-block py-3 px-6 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
                style={{
                  background: c.text,
                  color: c.bg,
                  fontSize: "0.95rem",
                  textDecoration: "none",
                }}
              >
                Request a quote
              </a>
            </div>

            <aside
              className="rounded-2xl p-6 sm:p-7"
              style={{ background: c.elevated, border: `1px solid ${c.border}` }}
            >
              <p
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.72rem",
                  fontWeight: 500,
                  color: c.teal,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  marginBottom: "1rem",
                }}
              >
                A defined outcome
              </p>
              <p
                style={{
                  fontSize: "1.1rem",
                  lineHeight: 1.5,
                  color: c.text,
                  marginBottom: "0.75rem",
                }}
              >
                Scope the application, settings, versions, and verification before any money changes
                hands.
              </p>
              <p style={{ fontSize: "0.9rem", lineHeight: 1.65, color: c.textSec, margin: 0 }}>
                There is no catalogue price: each integration is a different piece of migration
                work.
              </p>
            </aside>
          </div>
        </section>

        <section className="py-20 sm:py-24 px-6" style={{ borderTop: `1px solid ${c.border}` }}>
          <div className="mx-auto" style={{ maxWidth: 1100 }}>
            <div style={{ maxWidth: 700, marginBottom: "2rem" }}>
              <p
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  color: c.textSec,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: "0.75rem",
                }}
              >
                The distinction
              </p>
              <h2
                style={{
                  fontSize: "clamp(1.8rem, 3.5vw, 2.5rem)",
                  fontWeight: 700,
                  letterSpacing: "-0.035em",
                  color: c.text,
                  margin: 0,
                }}
              >
                Installing an application is not migrating it
              </h2>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <article
                className="rounded-2xl p-6 sm:p-7"
                data-migration-comparison
                style={{ background: c.card, border: `1px solid ${c.border}` }}
              >
                <p
                  style={{
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                    fontSize: "0.72rem",
                    fontWeight: 500,
                    color: c.teal,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    marginBottom: "1rem",
                  }}
                >
                  Installation
                </p>
                <h3 style={{ color: c.text, fontSize: "1.25rem", marginBottom: "1rem" }}>
                  The application arrives
                </h3>
                <P>
                  Package installation is a solved problem, and Endstate already uses it. Point it
                  at a package identity and the application arrives on the new machine, at the
                  version the package feed serves, configured exactly as its own installer leaves
                  it.
                </P>
              </article>

              <article
                className="rounded-2xl p-6 sm:p-7"
                data-migration-comparison
                style={{ background: c.elevated, border: `1px solid ${c.borderAccent}` }}
              >
                <p
                  style={{
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                    fontSize: "0.72rem",
                    fontWeight: 500,
                    color: c.copper,
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    marginBottom: "1rem",
                  }}
                >
                  Migration support
                </p>
                <h3 style={{ color: c.text, fontSize: "1.25rem", marginBottom: "1rem" }}>
                  The working state survives
                </h3>
                <P>
                  Migration support is the part that is not solved. It means knowing which files and
                  registry keys hold the settings that matter, which of them are safe to move and
                  which are machine-bound, licence-bound, or contain credentials that must never be
                  copied.
                </P>
                <P>
                  It means handling the shape those settings take in different versions and
                  editions, reconciling package identities that differ between feeds or change under
                  the project&rsquo;s feet, then testing the round trip on a clean machine and
                  writing down what it does and does not cover.
                </P>
              </article>
            </div>
            <p
              style={{ fontSize: "1rem", lineHeight: 1.7, color: c.textSec, margin: "1.5rem 0 0" }}
            >
              That work is specific to each application, and it is what a sponsorship pays for.
            </p>
          </div>
        </section>

        <section className="py-20 sm:py-24 px-6" style={{ borderTop: `1px solid ${c.border}` }}>
          <div className="mx-auto" style={{ maxWidth: 1100 }}>
            <div style={{ maxWidth: 700, marginBottom: "2rem" }}>
              <p
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  color: c.textSec,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  marginBottom: "0.75rem",
                }}
              >
                A narrow promise
              </p>
              <h2
                style={{
                  fontSize: "clamp(1.8rem, 3.5vw, 2.5rem)",
                  fontWeight: 700,
                  letterSpacing: "-0.035em",
                  color: c.text,
                  marginBottom: "1.25rem",
                }}
              >
                What sponsorship does and does not buy
              </h2>
              <P>
                Ordinary Endstate development continues regardless, and so do community
                contributions — anyone can open a pull request for an application module, and
                sponsorship does not close that door or move anyone else down a queue they were
                promised a place in.
              </P>
              <p style={{ fontSize: "1rem", lineHeight: 1.75, color: c.textSec, margin: 0 }}>
                What a sponsorship buys is narrow and concrete:
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <article
                className="rounded-2xl p-6"
                data-sponsorship-benefit
                style={{ background: c.card, border: `1px solid ${c.border}` }}
              >
                <p
                  style={{
                    color: c.copper,
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                    fontSize: "0.75rem",
                    marginBottom: "1rem",
                  }}
                >
                  01
                </p>
                <h3 style={{ fontSize: "1.15rem", color: c.text, marginBottom: "0.75rem" }}>
                  Priority
                </h3>
                <p style={{ fontSize: "0.95rem", lineHeight: 1.65, color: c.textSec, margin: 0 }}>
                  The work is scheduled and done, rather than waiting for the application to reach
                  the top of the list on its own.
                </p>
              </article>
              <article
                className="rounded-2xl p-6"
                data-sponsorship-benefit
                style={{ background: c.card, border: `1px solid ${c.border}` }}
              >
                <p
                  style={{
                    color: c.copper,
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                    fontSize: "0.75rem",
                    marginBottom: "1rem",
                  }}
                >
                  02
                </p>
                <h3 style={{ fontSize: "1.15rem", color: c.text, marginBottom: "0.75rem" }}>
                  Explicit scope
                </h3>
                <p style={{ fontSize: "0.95rem", lineHeight: 1.65, color: c.textSec, margin: 0 }}>
                  The quote names the settings, versions, and editions covered, and says what is out
                  of scope, before any money changes hands.
                </p>
              </article>
              <article
                className="rounded-2xl p-6"
                data-sponsorship-benefit
                style={{ background: c.card, border: `1px solid ${c.border}` }}
              >
                <p
                  style={{
                    color: c.copper,
                    fontFamily: "var(--font-jetbrains-mono), monospace",
                    fontSize: "0.75rem",
                    marginBottom: "1rem",
                  }}
                >
                  03
                </p>
                <h3 style={{ fontSize: "1.15rem", color: c.text, marginBottom: "0.75rem" }}>
                  Verification
                </h3>
                <p style={{ fontSize: "0.95rem", lineHeight: 1.65, color: c.textSec, margin: 0 }}>
                  The integration is tested end to end on a clean machine, and the result is
                  documented.
                </p>
              </article>
            </div>
            <p
              style={{ fontSize: "1rem", lineHeight: 1.7, color: c.textSec, margin: "1.5rem 0 0" }}
            >
              It does not buy influence over the rest of the roadmap, a support contract, or any
              change to the free product, which stays free and complete either way.
            </p>
          </div>
        </section>

        <section
          className="py-20 sm:py-24 px-6"
          style={{ background: c.elevated, borderTop: `1px solid ${c.border}` }}
        >
          <div className="mx-auto grid gap-4 lg:grid-cols-3" style={{ maxWidth: 1100 }}>
            <article
              className="rounded-2xl p-6 sm:p-7"
              style={{ background: c.card, border: `1px solid ${c.border}` }}
            >
              <p
                style={{
                  color: c.teal,
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.72rem",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  marginBottom: "1rem",
                }}
              >
                Public work
              </p>
              <h2 style={{ fontSize: "1.25rem", color: c.text, marginBottom: "1rem" }}>
                Public integrations stay free and open source
              </h2>
              <P>
                A sponsored public integration becomes part of Endstate itself: open source under
                Apache 2.0, in the public module catalogue, and available to everyone at no cost.
                You are funding work that is given away, and the application&rsquo;s other users
                benefit from it too.
              </P>
            </article>

            <article
              className="rounded-2xl p-6 sm:p-7"
              style={{ background: c.card, border: `1px solid ${c.border}` }}
            >
              <p
                style={{
                  color: c.teal,
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.72rem",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  marginBottom: "1rem",
                }}
              >
                Private work
              </p>
              <h2 style={{ fontSize: "1.25rem", color: c.text, marginBottom: "1rem" }}>
                Organisational and vendor work
              </h2>
              <P>
                Private organisational and vendor integrations — for internal line-of-business
                software, or for a vendor who does not want a public module — are available by
                quotation and are handled separately.
              </P>
            </article>

            <article
              className="rounded-2xl p-6 sm:p-7"
              style={{ background: c.card, border: `1px solid ${c.border}` }}
            >
              <p
                style={{
                  color: c.teal,
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.72rem",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  marginBottom: "1rem",
                }}
              >
                Maintenance boundaries
              </p>
              <h2 style={{ fontSize: "1.25rem", color: c.text, marginBottom: "1rem" }}>
                What a completed sponsorship does not imply
              </h2>
              <P>
                A sponsorship is delivered work, not a maintenance commitment. When it is complete,
                the integration exists, is tested, and is documented. It does not come with lifetime
                maintenance, and applications change: a vendor can move a configuration file,
                restructure a settings format, or change package identity at any time, and a working
                integration can stop working through no fault of either side.
              </P>
              <P>
                Ongoing compatibility guarantees are a different thing and require a separate
                agreement. If you need an integration to keep working against future releases, say
                so in your enquiry and we will scope that explicitly rather than leave it implied.
              </P>
            </article>
          </div>
        </section>

        <section className="py-20 sm:py-24 px-6" style={{ borderTop: `1px solid ${c.border}` }}>
          <div className="mx-auto" style={{ maxWidth: 1100 }}>
            <div
              className="rounded-2xl p-6 sm:p-8 lg:p-10"
              data-quote-panel
              style={{ background: c.card, border: `1px solid ${c.borderAccent}` }}
            >
              <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-start">
                <div>
                  <p
                    style={{
                      fontFamily: "var(--font-jetbrains-mono), monospace",
                      fontSize: "0.75rem",
                      fontWeight: 500,
                      color: c.copper,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      marginBottom: "1rem",
                    }}
                  >
                    Request a quote
                  </p>
                  <h2
                    style={{
                      fontSize: "clamp(1.8rem, 3.5vw, 2.5rem)",
                      fontWeight: 700,
                      letterSpacing: "-0.035em",
                      color: c.text,
                      marginBottom: "1.25rem",
                    }}
                  >
                    Start with the application you need to move
                  </h2>
                  <P>
                    There is no public price, because there is no standard job — an application with
                    two settings files and one package identity is not the same work as one with
                    per-edition registry layouts and a licence blob that must not be copied. Send
                    the details below and you will get a scope and a price.
                  </P>
                  <P>
                    The link below opens your email client with those questions already in the body
                    — fill in what you know and send it. Nothing is stored anywhere until you reply.
                  </P>
                  <a
                    href={INTAKE_MAILTO}
                    className="inline-block py-3 px-6 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
                    style={{
                      background: c.text,
                      color: c.bg,
                      fontSize: "0.95rem",
                      textDecoration: "none",
                    }}
                  >
                    Request a quote
                  </a>
                </div>

                <div
                  className="rounded-xl p-5 sm:p-6"
                  style={{ background: c.elevated, border: `1px solid ${c.border}` }}
                >
                  <p
                    style={{
                      fontFamily: "var(--font-jetbrains-mono), monospace",
                      fontSize: "0.72rem",
                      fontWeight: 500,
                      color: c.textSec,
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      marginBottom: "1rem",
                    }}
                  >
                    What to include
                  </p>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {INTAKE_FIELDS.map((field) => (
                      <Li key={field}>{field.replace(/:$/, "")}</Li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            <p
              style={{
                fontSize: "0.85rem",
                color: c.textSec,
                marginTop: "1.5rem",
                lineHeight: 1.6,
              }}
            >
              Prefer to support the project in general rather than one application?{" "}
              <a
                href="/endstate/supporters#support"
                style={{
                  color: c.textSec,
                  textDecoration: "underline",
                  textDecorationColor: "rgba(153,153,153,0.3)",
                }}
              >
                Support Endstate
              </a>
              .
            </p>
          </div>
        </section>

        <EndstateFooter />
      </main>
    </>
  );
}
