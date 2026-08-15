import type { ReactNode } from "react";
import Link from "next/link";

export function ExomemPublicPage({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: ReactNode;
}) {
  return (
    <main
      className="brand-exomem"
      style={{ minHeight: "100vh", padding: "48px clamp(20px, 5vw, 48px) 80px" }}
    >
      <article style={{ maxWidth: "46rem", margin: "0 auto" }}>
        <Link
          href="/exomem"
          className="exo-link-ts"
          style={{ fontFamily: "var(--font-mono-exo)", fontSize: "12px" }}
        >
          ← Exomem
        </Link>
        <p
          style={{
            margin: "48px 0 0",
            fontFamily: "var(--font-mono-exo)",
            fontSize: "11px",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: "var(--fg-tertiary)",
          }}
        >
          {eyebrow}
        </p>
        <h1
          style={{
            margin: "18px 0 32px",
            fontFamily: "var(--font-mono-exo)",
            fontSize: "clamp(2rem, 5vw, 3rem)",
            letterSpacing: "-0.04em",
          }}
        >
          {title}
        </h1>
        <div
          className="exo-prose"
          style={{
            color: "var(--fg-secondary)",
            fontSize: "1rem",
            fontWeight: 300,
            lineHeight: 1.75,
          }}
        >
          {children}
        </div>
        <nav
          aria-label="Exomem information"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "12px 24px",
            marginTop: "48px",
            paddingTop: "24px",
            borderTop: "1px solid var(--exo-rule)",
            fontFamily: "var(--font-mono-exo)",
            fontSize: "12px",
          }}
        >
          <Link href="/exomem/setup" className="exo-link-ts">
            Setup
          </Link>
          <Link href="/exomem/benchmarks" className="exo-link-ts">
            Benchmarks
          </Link>
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
      </article>
    </main>
  );
}
