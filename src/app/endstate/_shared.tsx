"use client";

import Link from "next/link";

/* ── Palette ── */
export const c = {
  bg: "#0c0c0c",
  elevated: "#141414",
  card: "#1a1a1a",
  cardHover: "#1e1e1e",
  border: "#2a2a2a",
  borderAccent: "#333",
  text: "#e8e8e8",
  textSec: "#999",
  textMuted: "#666",
  teal: "#2dd4bf",
  green: "#22c55e",
  copper: "#c87941",
  blue: "#3b82f6",
};

/* ── Fade-up animation helper ── */
export const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.8, ease: "easeOut" as const, delay },
});

/* ── Nav ── */
export function Nav() {
  return (
    <nav
      className="fixed top-0 w-full z-30 backdrop-blur-md border-b"
      style={{ background: "rgba(12,12,12,0.85)", borderColor: c.border }}
    >
      <div className="mx-auto max-w-5xl px-6 h-14 flex items-center">
        {/* Left */}
        <div className="flex-1">
          <Link
            href="/"
            className="text-sm transition-colors duration-200"
            style={{ color: c.textSec }}
            onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
          >
            ← Substrate
          </Link>
        </div>
        {/* Center */}
        <div className="flex items-center gap-2">
          <img src="/endstate/icons/transparent/transparent-sw5.svg" alt="" width={24} height={24} className="block" />
          <Link href="/endstate" className="font-bold tracking-tight" style={{ color: c.text, fontSize: "1.1rem", textDecoration: "none" }}>
            Endstate
          </Link>
        </div>
        {/* Right */}
        <div className="flex-1 flex items-center justify-end gap-3 sm:gap-8">
          <a
            href="/endstate#how-it-works"
            className="text-sm hidden lg:block transition-colors duration-200"
            style={{ color: c.textSec }}
            onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
          >
            How it works
          </a>
          <a
            href="/endstate#pricing"
            className="text-sm hidden lg:block transition-colors duration-200"
            style={{ color: c.textSec }}
            onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
          >
            Pricing
          </a>
          <a
            href="/endstate#pricing"
            className="text-sm font-semibold px-4 py-1.5 rounded-md hover:opacity-85 transition-opacity duration-200 whitespace-nowrap hidden sm:block"
            style={{ background: c.text, color: c.bg }}
          >
            Get Endstate
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ── Footer ── */
export function EndstateFooter() {
  return (
    <footer
      className="py-16 px-6"
      style={{ background: c.bg, borderTop: `1px solid ${c.border}` }}
    >
      <div className="mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4" style={{ maxWidth: 1100 }}>
        <p style={{ fontSize: "0.8rem", color: c.textMuted }}>
          Substrate Systems
        </p>
        <p style={{ fontSize: "0.8rem", color: c.textMuted }}>
          The provisioning engine is open source —{" "}
          <a
            href="https://github.com/Artexis10/endstate"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors duration-200"
            style={{ color: c.textSec, textDecoration: "none" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
          >
            github.com/Artexis10/endstate
          </a>
        </p>
        <div className="flex items-center gap-4">
          <Link
            href="/terms"
            className="transition-colors duration-200"
            style={{ fontSize: "0.8rem", color: c.textSec, textDecoration: "none" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
          >
            Terms &amp; Privacy
          </Link>
          <a
            href="mailto:hello@substratesystems.com"
            className="transition-colors duration-200"
            style={{ fontSize: "0.8rem", color: c.textSec, textDecoration: "none" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
          >
            hello@substratesystems.com
          </a>
        </div>
      </div>
    </footer>
  );
}
