"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { c, fadeUp, Nav, EndstateFooter } from "../_shared";

export default function WhyPage() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500&display=swap"
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
        <Nav />

        <article className="pt-32 sm:pt-40 pb-24 px-6">
          <div className="mx-auto" style={{ maxWidth: 680 }}>
            {/* Date */}
            <motion.p
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.75rem",
                fontWeight: 500,
                color: c.textMuted,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                marginBottom: "1.5rem",
              }}
              {...fadeUp(0)}
            >
              April 2026
            </motion.p>

            {/* Title */}
            <motion.h1
              style={{
                fontSize: "clamp(2rem, 4.5vw, 2.8rem)",
                fontWeight: 700,
                lineHeight: 1.15,
                letterSpacing: "-0.03em",
                color: c.text,
                marginBottom: "2.5rem",
              }}
              {...fadeUp(0.1)}
            >
              Why I Built Endstate
            </motion.h1>

            {/* First paragraph — animated */}
            <motion.p style={prose} {...fadeUp(0.2)}>
              Every time I set up a fresh Windows machine, the same ritual
              begins. Open a browser. Search for the apps I need. Download them
              one by one. Install them. Then the worse part — realize my settings
              are gone.
            </motion.p>

            {/* Remaining body — no per-paragraph animation */}
            <div>
              <p style={prose}>
                My Lightroom develop presets, carefully built over years. MSI
                Afterburner overclocking profiles — but worse, the overlay. If
                you&apos;ve ever configured an Afterburner overlay, you know: the
                sensor layout, the positioning, which metrics to show, the font
                sizes, the colors. It&apos;s hours of careful tweaking. Gone in one
                reinstall.
              </p>

              <p style={prose}>
                I&apos;d keep a mental checklist. Sometimes a text file. Sometimes a
                PowerShell script that half-worked. None of it stuck, and none of
                it handled the settings problem. The apps were annoying to
                reinstall, but the configurations — the stuff that made my
                machine <em>mine</em> — that was the real loss.
              </p>

              <p style={prose}>
                I looked for tools. Ninite installs apps but only from a fixed
                list and doesn&apos;t touch configuration. Winget is powerful but
                it&apos;s a package manager, not a provisioning system — it installs,
                it doesn&apos;t restore. Chocolatey is aimed at DevOps. Microsoft
                recently added multi-app install packs to the Store, but it&apos;s
                limited to a small set of curated apps and again, install-only.
                None of these capture both your apps and their settings as a
                single, portable snapshot you can take to a new machine.
              </p>

              <p style={prose}>So I built Endstate.</p>

              <p style={prose}>
                Endstate captures what&apos;s installed on your Windows machine and
                how it&apos;s configured, then restores it on a fresh install. It&apos;s
                declarative — you describe your desired end state, and the tool
                converges your machine toward it. Apps get installed via winget.
                Settings get restored from portable snapshots. The whole thing is
                idempotent: run it twice, nothing breaks.
              </p>

              <p style={prose}>
                The engine is a{" "}
                <a
                  href="https://github.com/Artexis10/endstate"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: c.teal, textDecoration: "none" }}
                >
                  Go CLI, open source under Apache 2.0
                </a>
                . The desktop app is built with Tauri (React + Rust). It&apos;s
                designed to be transparent — your setup is a folder in Documents
                you can inspect, copy, or back up. No hidden databases, no cloud
                dependency, no account required.
              </p>

              <p style={prose}>
                It&apos;s still early. I&apos;m a solo developer working on this through
                my company, Substrate Systems. But the core loop works: capture
                your machine, move to a new one, get your environment back.
              </p>

              <p style={prose}>
                If you&apos;ve ever dreaded a fresh install, that&apos;s why Endstate
                exists.
              </p>
            </div>

            {/* Byline */}
            <div
              className="mt-16 pt-8"
              style={{ borderTop: `1px solid ${c.border}` }}
            >
              <p
                style={{
                  fontSize: "0.85rem",
                  color: c.textMuted,
                  marginBottom: "1.5rem",
                }}
              >
                Written by Hugo Ander Kivi · Substrate Systems
              </p>
              <Link
                href="/endstate"
                className="transition-colors duration-200"
                style={{
                  fontSize: "0.9rem",
                  color: c.textSec,
                  textDecoration: "none",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
                onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
              >
                Back to Endstate →
              </Link>
            </div>
          </div>
        </article>

        <EndstateFooter />
      </main>
    </>
  );
}

const prose: React.CSSProperties = {
  fontSize: "1.05rem",
  lineHeight: 1.8,
  color: "#bbb",
  marginBottom: "1.5rem",
};
