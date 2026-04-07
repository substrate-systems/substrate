import Link from "next/link";

const c = {
  bg: "#0c0c0c",
  border: "#2a2a2a",
  text: "#e8e8e8",
  textSec: "#999",
  textMuted: "#666",
  teal: "#2dd4bf",
};

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2
      id={id}
      style={{
        fontSize: "1.6rem",
        fontWeight: 700,
        letterSpacing: "-0.02em",
        color: c.text,
        marginBottom: "1.5rem",
        paddingTop: "3rem",
      }}
    >
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: "0.92rem", color: c.textSec, lineHeight: 1.8, marginBottom: "1rem" }}>
      {children}
    </p>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li
      className="flex gap-2"
      style={{ fontSize: "0.92rem", color: c.textSec, lineHeight: 1.8, marginBottom: "0.5rem" }}
    >
      <span style={{ color: c.teal, flexShrink: 0 }}>—</span>
      <span>{children}</span>
    </li>
  );
}

export default function TermsPage() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&display=swap"
        rel="stylesheet"
      />
      <main
        style={{
          fontFamily: "'DM Sans', -apple-system, sans-serif",
          background: c.bg,
          minHeight: "100vh",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <div className="mx-auto px-6 py-16 sm:py-24" style={{ maxWidth: 680 }}>
          {/* Back link */}
          <Link
            href="/endstate"
            className="inline-block mb-12 text-sm transition-colors duration-200 hover:text-white"
            style={{ color: c.textSec, textDecoration: "none" }}
          >
            <span style={{ color: c.teal }}>←</span>{" "}
            Back to Endstate
          </Link>

          {/* Title */}
          <h1
            style={{
              fontSize: "clamp(1.8rem, 4vw, 2.4rem)",
              fontWeight: 700,
              letterSpacing: "-0.03em",
              color: c.text,
              marginBottom: "0.5rem",
            }}
          >
            Terms, Privacy &amp; Refunds
          </h1>
          <p style={{ fontSize: "0.85rem", color: c.textMuted, marginBottom: "3rem" }}>
            Last updated: April 2026 · Substrate Systems OÜ · Estonia
          </p>

          <div style={{ borderTop: `1px solid ${c.border}` }} />

          {/* ── Terms of Service ── */}
          <SectionHeading id="terms">Terms of Service</SectionHeading>

          <P>
            By purchasing or using Endstate, you agree to these terms. Endstate is a product
            of Substrate Systems OÜ, registered in Estonia.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            License
          </h3>
          <P>
            Your purchase grants a lifetime, non-exclusive, non-transferable license to use
            Endstate on up to 3 machines. The license is tied to you personally and may not
            be resold or shared.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Open source
          </h3>
          <P>
            The provisioning engine and GUI framework are licensed under Apache 2.0. Your
            purchase covers the pre-built desktop application and activation key — not the
            open-source components, which remain freely available under their own license.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Updates
          </h3>
          <P>
            All future updates to the current major version are included with your purchase
            at no additional cost.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            No warranty &amp; limitation of liability
          </h3>
          <P>
            Endstate is provided &ldquo;as is&rdquo; without warranty of any kind, express or implied.
            Substrate Systems OÜ shall not be liable for any damages arising from the use
            or inability to use the software, including but not limited to data loss,
            system damage, or lost profits.
          </P>

          <div style={{ borderTop: `1px solid ${c.border}`, marginTop: "2rem" }} />

          {/* ── Privacy Policy ── */}
          <SectionHeading id="privacy">Privacy Policy</SectionHeading>

          <P>
            Endstate is designed to work offline. We do not collect data during normal use.
          </P>

          <ul style={{ listStyle: "none", padding: 0, margin: "1rem 0" }}>
            <Li>
              Scanning and saving your machine setup works entirely offline. No data leaves
              your computer.
            </Li>
            <Li>
              License activation sends your license key and a machine fingerprint to our
              payment processor for validation. Nothing else is transmitted.
            </Li>
            <Li>
              App installation downloads packages via winget directly from publishers. We
              are not involved in that process and do not proxy or log those downloads.
            </Li>
            <Li>
              We do not use analytics, telemetry, or tracking of any kind.
            </Li>
          </ul>

          <P>
            For privacy questions, contact{" "}
            <a href="mailto:founder@substratesystems.io" style={{ color: c.teal, textDecoration: "none" }}>
              founder@substratesystems.io
            </a>
            .
          </P>

          <div style={{ borderTop: `1px solid ${c.border}`, marginTop: "2rem" }} />

          {/* ── Refund Policy ── */}
          <SectionHeading id="refunds">Refund Policy</SectionHeading>

          <P>
            We offer a 30-day money-back guarantee, no questions asked.
          </P>
          <P>
            To request a refund, email{" "}
            <a href="mailto:founder@substratesystems.io" style={{ color: c.teal, textDecoration: "none" }}>
              founder@substratesystems.io
            </a>{" "}
            with your order number. Refunds are typically processed within a few business days.
          </P>

          {/* Footer */}
          <div style={{ borderTop: `1px solid ${c.border}`, marginTop: "3rem", paddingTop: "2rem" }}>
            <p style={{ fontSize: "0.8rem", color: c.textMuted }}>
              © {new Date().getFullYear()} Substrate Systems OÜ · Estonia
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
