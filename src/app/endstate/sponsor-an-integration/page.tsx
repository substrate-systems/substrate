import { c, Nav, EndstateFooter } from "../_shared";

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
    <p
      style={{
        fontSize: "1rem",
        lineHeight: 1.75,
        color: c.textSec,
        marginBottom: "1.25rem",
      }}
    >
      {children}
    </p>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        fontSize: "clamp(1.4rem, 3vw, 1.75rem)",
        fontWeight: 700,
        letterSpacing: "-0.025em",
        color: c.text,
        marginTop: "3.5rem",
        marginBottom: "1.25rem",
      }}
    >
      {children}
    </h2>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li
      className="flex gap-3"
      style={{
        fontSize: "1rem",
        lineHeight: 1.7,
        color: c.textSec,
        marginBottom: "0.65rem",
      }}
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

        <section className="pt-32 sm:pt-40 pb-24 px-6">
          <div className="mx-auto" style={{ maxWidth: 680 }}>
            <p
              style={{
                fontFamily: "var(--font-jetbrains-mono), monospace",
                fontSize: "0.75rem",
                fontWeight: 500,
                color: c.textMuted,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: "1.5rem",
              }}
            >
              Sponsor an integration
            </p>

            <h1
              style={{
                fontSize: "clamp(2rem, 4.5vw, 2.8rem)",
                fontWeight: 700,
                lineHeight: 1.15,
                letterSpacing: "-0.03em",
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
                marginBottom: "2.5rem",
              }}
            >
              Endstate already reinstalls applications through WinGet and Chocolatey. Integration
              sponsorship funds deeper migration support: safe settings capture and restore, version
              handling, package-identity edge cases, testing, and documentation.
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

            <H2>Installing an application is not migrating it</H2>
            <P>
              Package installation is a solved problem, and Endstate already uses it. Point it at a
              package identity and the application arrives on the new machine, at the version the
              package feed serves, configured exactly as its own installer leaves it.
            </P>
            <P>
              Migration support is the part that is not solved. It means knowing which files and
              registry keys hold the settings that matter, which of them are safe to move and which
              are machine-bound, licence-bound, or contain credentials that must never be copied. It
              means handling the shape those settings take in different versions and editions,
              reconciling package identities that differ between feeds or change under the
              project&rsquo;s feet, then testing the round trip on a clean machine and writing down
              what it does and does not cover.
            </P>
            <P>That work is specific to each application, and it is what a sponsorship pays for.</P>

            <H2>What sponsorship does and does not buy</H2>
            <P>
              Ordinary Endstate development continues regardless, and so do community contributions
              — anyone can open a pull request for an application module, and sponsorship does not
              close that door or move anyone else down a queue they were promised a place in.
            </P>
            <P>What a sponsorship buys is narrow and concrete:</P>
            <ul style={{ listStyle: "none", padding: 0, margin: "1.25rem 0 1.5rem" }}>
              <Li>
                <strong style={{ color: c.text }}>Priority.</strong> The work is scheduled and done,
                rather than waiting for the application to reach the top of the list on its own.
              </Li>
              <Li>
                <strong style={{ color: c.text }}>Explicit scope.</strong> The quote names the
                settings, versions, and editions covered, and says what is out of scope, before any
                money changes hands.
              </Li>
              <Li>
                <strong style={{ color: c.text }}>Verification.</strong> The integration is tested
                end to end on a clean machine, and the result is documented.
              </Li>
            </ul>
            <P>
              It does not buy influence over the rest of the roadmap, a support contract, or any
              change to the free product, which stays free and complete either way.
            </P>

            <H2>Public integrations stay free and open source</H2>
            <P>
              A sponsored public integration becomes part of Endstate itself: open source under
              Apache 2.0, in the public module catalogue, and available to everyone at no cost. You
              are funding work that is given away, and the application&rsquo;s other users benefit
              from it too.
            </P>
            <P>
              Private organisational and vendor integrations — for internal line-of-business
              software, or for a vendor who does not want a public module — are available by
              quotation and are handled separately.
            </P>

            <H2>What a completed sponsorship does not imply</H2>
            <P>
              A sponsorship is delivered work, not a maintenance commitment. When it is complete,
              the integration exists, is tested, and is documented. It does not come with lifetime
              maintenance, and applications change: a vendor can move a configuration file,
              restructure a settings format, or change package identity at any time, and a working
              integration can stop working through no fault of either side.
            </P>
            <P>
              Ongoing compatibility guarantees are a different thing and require a separate
              agreement. If you need an integration to keep working against future releases, say so
              in your enquiry and we will scope that explicitly rather than leave it implied.
            </P>

            <H2>Request a quote</H2>
            <P>
              There is no public price, because there is no standard job — an application with two
              settings files and one package identity is not the same work as one with per-edition
              registry layouts and a licence blob that must not be copied. Send the details below
              and you will get a scope and a price.
            </P>
            <div
              style={{
                border: `1px solid ${c.border}`,
                borderRadius: 12,
                padding: "1.75rem",
                background: c.card,
                marginBottom: "1.5rem",
              }}
            >
              <p
                style={{
                  fontFamily: "var(--font-jetbrains-mono), monospace",
                  fontSize: "0.72rem",
                  fontWeight: 500,
                  color: c.textMuted,
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
            <P>
              The link below opens your email client with those questions already in the body — fill
              in what you know and send it. Nothing is stored anywhere until you reply.
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

            <p
              style={{
                fontSize: "0.85rem",
                color: c.textMuted,
                marginTop: "2.5rem",
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
