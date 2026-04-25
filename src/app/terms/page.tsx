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

          {/* ── Overview ── */}
          <SectionHeading id="overview">Overview</SectionHeading>
          <P>
            Endstate is a product of Substrate Systems OÜ, registered in Estonia. By
            downloading or using Endstate, or by subscribing to any of its paid services,
            you agree to these terms.
          </P>
          <P>
            Endstate is offered in three forms:
          </P>
          <ul style={{ listStyle: "none", padding: 0, margin: "1rem 0" }}>
            <Li>
              <strong style={{ color: c.text }}>The free local product</strong> — the
              Endstate engine (CLI) and GUI, free to download and use forever, with no
              account required.
            </Li>
            <Li>
              <strong style={{ color: c.text }}>Hosted Backup</strong> — an optional paid
              subscription to Endstate&apos;s managed encrypted backup service. Currently in
              early access; not yet generally available.
            </Li>
            <Li>
              <strong style={{ color: c.text }}>Supporter License</strong> — an optional
              one-time payment that supports development. It does not unlock additional
              features.
            </Li>
          </ul>
          <P>
            How these tiers behave is governed by the{" "}
            <a
              href="https://github.com/Artexis10/endstate/blob/main/PRINCIPLES.md"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: c.teal, textDecoration: "none" }}
            >
              Endstate Principles
            </a>
            , which are public commitments about what Endstate will and will not do. Where
            these terms appear to weaken a principle, the principle wins.
          </P>

          <div style={{ borderTop: `1px solid ${c.border}`, marginTop: "2rem" }} />

          {/* ── Terms of Service ── */}
          <SectionHeading id="terms">Terms of Service</SectionHeading>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Free local product
          </h3>
          <P>
            The free local product (engine and GUI) is provided at no cost, on an unlimited
            number of machines, without an account. It is yours to use, share, and run
            offline. The engine is licensed under Apache 2.0; the GUI is provided as a
            pre-built desktop application under these terms. You may not redistribute the
            pre-built GUI binaries commercially, but the underlying engine remains freely
            available under its open-source license.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Hosted Backup subscription
          </h3>
          <P>
            A Hosted Backup subscription grants access to Endstate&apos;s managed backup
            service for the term you have paid for (monthly or annual). Subscriptions renew
            automatically until cancelled. Cancelling stops future renewals; access remains
            active until the end of the paid period.
          </P>
          <P>
            Data uploaded to Hosted Backup is encrypted on your machine before it leaves
            using keys that you control. Endstate stores only ciphertext and metadata
            necessary to operate the service (account email, billing identifiers, object
            sizes, timestamps). Endstate cannot read or decrypt your backup data.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Supporter License
          </h3>
          <P>
            The Supporter License is a one-time, non-exclusive, non-transferable
            acknowledgement that you have contributed to the development of Endstate. It
            does not grant additional features beyond what the free product offers. With
            your explicit opt-in, your name may appear on the public supporters page and in
            the project repository. You can ask for removal at any time.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Acceptable use
          </h3>
          <P>
            You agree not to use Hosted Backup to store unlawful content, to store data
            you do not have the right to store, or to attempt to circumvent the encryption
            or storage limits of the service. Endstate may suspend service for violations
            of acceptable use after written notice, except where immediate action is legally
            required.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            No warranty &amp; limitation of liability
          </h3>
          <P>
            Endstate is provided &ldquo;as is&rdquo; without warranty of any kind, express or
            implied. Substrate Systems OÜ shall not be liable for any damages arising from
            the use or inability to use the software or services, including but not limited
            to data loss, system damage, or lost profits. For paid services, total
            liability is limited to the amount you paid in the twelve months preceding the
            claim.
          </P>

          <div style={{ borderTop: `1px solid ${c.border}`, marginTop: "2rem" }} />

          {/* ── Privacy Policy ── */}
          <SectionHeading id="privacy">Privacy Policy</SectionHeading>

          <P>
            Endstate&apos;s local product is designed to work offline. We do not collect
            usage analytics, crash reports, or behavioural data by default. Paid services
            necessarily process some personal data; we keep that to the minimum needed to
            operate them.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Local product
          </h3>
          <ul style={{ listStyle: "none", padding: 0, margin: "1rem 0" }}>
            <Li>
              Scanning, saving, and restoring your setup works entirely offline. No data
              leaves your computer.
            </Li>
            <Li>
              The local product does not connect to Endstate servers in the background.
              Network connections happen only when you take an action that requires them.
            </Li>
            <Li>
              App installation downloads packages via winget directly from publishers.
              We are not involved and do not proxy or log those downloads.
            </Li>
            <Li>
              No analytics, telemetry, or tracking. If telemetry is ever added it will be
              opt-in, anonymous, clearly described, and disable-able with a single toggle.
            </Li>
          </ul>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Hosted Backup
          </h3>
          <ul style={{ listStyle: "none", padding: 0, margin: "1rem 0" }}>
            <Li>
              Backup data is encrypted on your machine before upload. Endstate stores
              ciphertext and the metadata required to operate the service.
            </Li>
            <Li>
              We process: your account email, billing identifiers from our payment
              provider, object sizes, upload timestamps, and the IP address of your most
              recent connection (for abuse prevention).
            </Li>
            <Li>
              We do not read or decrypt your data. We cannot do so under subpoena, breach,
              or internal request — the keys live with you.
            </Li>
            <Li>
              <strong style={{ color: c.text }}>Data retention after cancellation:</strong>{" "}
              when you cancel a Hosted Backup subscription, your encrypted data is retained
              for 30 days to allow reactivation, then permanently deleted. You can request
              earlier deletion at any time.
            </Li>
          </ul>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Payment processing
          </h3>
          <P>
            Subscription and Supporter License purchases are processed by Paddle, which acts
            as merchant of record. Paddle handles your payment card details under its own
            privacy policy; Endstate receives transaction identifiers and your email
            address, not payment card data.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Your rights (GDPR)
          </h3>
          <P>
            EU residents have the right under GDPR to access, rectify, export, or delete
            their personal data, including data held by Hosted Backup. Because backup
            payloads are encrypted with keys we do not hold, &ldquo;access&rdquo; and
            &ldquo;export&rdquo; cover metadata and ciphertext only — you must use your
            local Endstate client to decrypt the contents. Contact{" "}
            <a href="mailto:founder@substratesystems.io" style={{ color: c.teal, textDecoration: "none" }}>
              founder@substratesystems.io
            </a>{" "}
            to exercise these rights.
          </P>

          <div style={{ borderTop: `1px solid ${c.border}`, marginTop: "2rem" }} />

          {/* ── Refund Policy ── */}
          <SectionHeading id="refunds">Refund Policy</SectionHeading>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Hosted Backup subscription
          </h3>
          <P>
            You can cancel a Hosted Backup subscription at any time from your account or by
            email. Cancelling stops the next renewal; access continues until the end of the
            current paid period.
          </P>
          <P>
            For monthly subscriptions, we do not pro-rate mid-period refunds — cancel
            before the next renewal to avoid further charges. For annual subscriptions, we
            offer a full refund within 14 days of purchase or renewal, no questions asked.
            EU consumers retain any statutory withdrawal rights they may have under local
            law.
          </P>

          <h3
            style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginTop: "1.5rem", marginBottom: "0.75rem" }}
          >
            Supporter License
          </h3>
          <P>
            Supporter License purchases are refundable within 30 days of purchase, no
            questions asked. After 30 days, refunds are at our discretion.
          </P>

          <P>
            To request a refund, email{" "}
            <a href="mailto:founder@substratesystems.io" style={{ color: c.teal, textDecoration: "none" }}>
              founder@substratesystems.io
            </a>{" "}
            with your order number. Refunds are typically processed within a few business
            days.
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
