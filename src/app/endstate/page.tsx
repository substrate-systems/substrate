"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

function useInView(options = { threshold: 0.15 }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([e]) => e.isIntersecting && setVisible(true),
      options
    );
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  return { ref, visible };
}

const fadeUp = (delay = 0) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.8, ease: "easeOut", delay },
});

/* ── Palette ── */
const c = {
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

/* ── Nav ── */
function Nav() {
  return (
    <nav
      className="fixed top-0 w-full z-30 backdrop-blur-md border-b"
      style={{ background: "rgba(12,12,12,0.85)", borderColor: c.border }}
    >
      <div className="mx-auto max-w-5xl px-6 h-14 flex items-center justify-between">
        <Link
          href="/"
          className="text-sm transition-colors duration-200"
          style={{ color: c.textSec }}
          onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
          onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
        >
          ← Substrate Systems
        </Link>
        <div className="flex items-center gap-2 absolute left-1/2 -translate-x-1/2">
          <img src="/endstate/mark-light.svg" alt="" width={24} height={24} className="block" />
          <span className="font-bold tracking-tight" style={{ color: c.text, fontSize: "1.1rem" }}>
            Endstate
          </span>
        </div>
        <div className="flex items-center gap-8">
          <a
            href="#how-it-works"
            className="text-sm hidden sm:block transition-colors duration-200"
            style={{ color: c.textSec }}
            onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
          >
            How it works
          </a>
          <a
            href="#pricing"
            className="text-sm hidden sm:block transition-colors duration-200"
            style={{ color: c.textSec }}
            onMouseEnter={(e) => (e.currentTarget.style.color = c.text)}
            onMouseLeave={(e) => (e.currentTarget.style.color = c.textSec)}
          >
            Pricing
          </a>
          <a
            href="#pricing"
            className="text-sm font-semibold px-4 py-1.5 rounded-md hover:opacity-85 transition-opacity duration-200"
            style={{ background: c.text, color: c.bg }}
          >
            Get Endstate
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ── Hero ── */
function Hero() {
  return (
    <section className="pt-40 pb-24 px-6" style={{ background: c.bg }}>
      <div className="mx-auto max-w-3xl text-center">
        <motion.span
          className="inline-block rounded-full mb-8"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: "0.75rem",
            fontWeight: 500,
            color: c.teal,
            border: `1px solid rgba(45, 212, 191, 0.25)`,
            background: "rgba(45, 212, 191, 0.06)",
            padding: "0.35rem 0.85rem",
            letterSpacing: "0.03em",
          }}
          {...fadeUp(0)}
        >
          Windows machine provisioning
        </motion.span>
        <motion.h1
          className="mb-6"
          style={{
            fontSize: "clamp(2.5rem, 5.5vw, 4rem)",
            fontWeight: 700,
            lineHeight: 1.1,
            letterSpacing: "-0.035em",
            color: c.text,
          }}
          {...fadeUp(0.1)}
        >
          Save your machine.
          <br />
          <span
            style={{
              background: "linear-gradient(135deg, #2dd4bf, #22c55e)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            Set up the next one.
          </span>
        </motion.h1>
        <motion.p
          className="mx-auto mb-10"
          style={{ fontSize: "1.2rem", color: c.textSec, maxWidth: 560, lineHeight: 1.7 }}
          {...fadeUp(0.2)}
        >
          Endstate captures every app and setting on your Windows machine,
          then restores them on a fresh install. One scan. One file. Done.
        </motion.p>
        <motion.div className="flex justify-center gap-4 flex-wrap" {...fadeUp(0.3)}>
          <a
            href="#pricing"
            className="inline-flex items-center gap-2 px-7 py-3 rounded-lg font-semibold hover:opacity-88 transition-all duration-200"
            style={{ background: c.text, color: c.bg, fontSize: "1rem" }}
          >
            Get Endstate — €39
          </a>
        </motion.div>
        <motion.p
          className="mt-4"
          style={{ fontSize: "0.85rem", color: c.textMuted }}
          {...fadeUp(0.4)}
        >
          One-time purchase · <strong style={{ color: c.textSec, fontWeight: 600 }}>Lifetime license</strong> · No subscription
        </motion.p>
      </div>
    </section>
  );
}

/* ── Showcase ── */
function Showcase() {
  const { ref, visible } = useInView();
  return (
    <section ref={ref} className="px-6 pb-32" style={{ background: c.bg }}>
      <motion.div
        className="mx-auto overflow-hidden"
        style={{
          maxWidth: 1100,
          borderRadius: 12,
          border: `1px solid ${c.border}`,
          background: c.card,
          boxShadow: `0 0 0 1px rgba(255,255,255,0.03), 0 20px 60px rgba(0,0,0,0.5), 0 0 120px rgba(45, 212, 191, 0.03)`,
        }}
        initial={{ opacity: 0, y: 16 }}
        animate={visible ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.9, ease: "easeOut" }}
      >
        <Image
          src="/endstate/01-landing.png"
          alt="Endstate — Save this computer or Set up this computer"
          width={1400}
          height={900}
          className="w-full block"
          priority
        />
      </motion.div>
    </section>
  );
}

/* ── Section label ── */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="block uppercase mb-3"
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "0.7rem",
        fontWeight: 500,
        color: c.copper,
        letterSpacing: "0.12em",
      }}
    >
      {children}
    </span>
  );
}

/* ── How it works ── */
function HowItWorks() {
  const { ref, visible } = useInView();
  return (
    <section
      ref={ref}
      id="how-it-works"
      className="py-32 px-6"
      style={{ background: c.bg, borderTop: `1px solid ${c.border}` }}
    >
      <div className="mx-auto" style={{ maxWidth: 1100 }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={visible ? { opacity: 1 } : {}}
          transition={{ duration: 0.7 }}
        >
          <SectionLabel>How it works</SectionLabel>
        </motion.div>
        <motion.h2
          className="mb-4"
          style={{ fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)", fontWeight: 700, letterSpacing: "-0.03em", color: c.text }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          Two screens. Zero guesswork.
        </motion.h2>
        <motion.p
          className="mb-20"
          style={{ fontSize: "1.05rem", color: c.textSec, maxWidth: 600, lineHeight: 1.7 }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          Scan your current machine, save everything to a portable file,
          load it on any fresh Windows install.
        </motion.p>

        <div className="grid md:grid-cols-2 gap-12">
          {/* Save */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={visible ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.8, delay: 0.3 }}
          >
            <span
              className="block mb-3 uppercase"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.7rem",
                fontWeight: 500,
                color: c.teal,
                letterSpacing: "0.12em",
              }}
            >
              01 — Save
            </span>
            <h3 className="mb-3" style={{ fontSize: "1.3rem", fontWeight: 600, color: c.text }}>
              Scan your machine
            </h3>
            <p className="mb-6" style={{ fontSize: "0.95rem", color: c.textSec, lineHeight: 1.7 }}>
              Endstate detects every installed app via winget and finds
              configuration files for supported apps. Everything gets
              bundled into a single portable file — no manual inventory required.
            </p>
            <div
              className="overflow-hidden"
              style={{ borderRadius: 8, border: `1px solid ${c.border}` }}
            >
              <Image
                src="/endstate/02-save-results.png"
                alt="Scan complete — 81 apps detected, 8 settings captured"
                width={1100}
                height={1000}
                className="w-full block"
              />
            </div>
          </motion.div>

          {/* Set up */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={visible ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.8, delay: 0.45 }}
          >
            <span
              className="block mb-3 uppercase"
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: "0.7rem",
                fontWeight: 500,
                color: c.teal,
                letterSpacing: "0.12em",
              }}
            >
              02 — Set up
            </span>
            <h3 className="mb-3" style={{ fontSize: "1.3rem", fontWeight: 600, color: c.text }}>
              Restore on a new machine
            </h3>
            <p className="mb-6" style={{ fontSize: "0.95rem", color: c.textSec, lineHeight: 1.7 }}>
              Load your saved file on a fresh Windows install. Endstate
              shows exactly what needs installing and what&apos;s already present.
              Choose whether to restore app settings, then apply.
            </p>
            <div
              className="overflow-hidden"
              style={{ borderRadius: 8, border: `1px solid ${c.border}` }}
            >
              <Image
                src="/endstate/03-setup-results.png"
                alt="Preview complete — 3 to install, 69 already present"
                width={1100}
                height={1100}
                className="w-full block"
              />
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ── Features ── */
const features = [
  {
    icon: "⚡",
    iconColor: c.teal,
    title: "Declarative capture",
    body: "Scans your machine and produces a manifest of every installed app. No manual lists. Works with winget's entire catalog.",
  },
  {
    icon: "⚙",
    iconColor: c.green,
    title: "Settings portability",
    body: "Captures and restores configuration files for supported apps — VS Code, Git, PowerShell, PowerToys, and more. Opt-in per app.",
  },
  {
    icon: "📦",
    iconColor: c.blue,
    title: "Portable profiles",
    body: "Everything saved as plain files in your Documents folder. Copy them, back them up, share them. No cloud accounts required.",
  },
  {
    icon: "🔁",
    iconColor: c.copper,
    title: "Idempotent & safe",
    body: "Re-run as many times as you want. Already-installed apps are skipped. Backups are created before any settings changes.",
  },
  {
    icon: "🔍",
    iconColor: c.teal,
    title: "Verify & audit",
    body: "Check whether your machine matches a profile without changing anything. Know exactly what's missing before you act.",
  },
  {
    icon: "↩",
    iconColor: c.green,
    title: "Always reversible",
    body: "Every settings restore creates a backup first. One click to revert. No destructive operations without explicit confirmation.",
  },
];

function Features() {
  const { ref, visible } = useInView();
  return (
    <section
      ref={ref}
      id="features"
      className="py-32 px-6"
      style={{ background: c.bg, borderTop: `1px solid ${c.border}` }}
    >
      <div className="mx-auto" style={{ maxWidth: 1100 }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={visible ? { opacity: 1 } : {}}
          transition={{ duration: 0.7 }}
        >
          <SectionLabel>Features</SectionLabel>
        </motion.div>
        <motion.h2
          className="mb-4"
          style={{ fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)", fontWeight: 700, letterSpacing: "-0.03em", color: c.text }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          Built for people who set up machines.
        </motion.h2>
        <motion.p
          className="mb-16"
          style={{ fontSize: "1.05rem", color: c.textSec, maxWidth: 600, lineHeight: 1.7 }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.15 }}
        >
          Whether you&apos;re a developer, sysadmin, or someone who just got a new laptop — Endstate gets you back to work faster.
        </motion.p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              className="p-6 rounded-lg transition-colors duration-200"
              style={{
                border: `1px solid ${c.border}`,
                background: c.card,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = c.borderAccent;
                e.currentTarget.style.background = c.cardHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = c.border;
                e.currentTarget.style.background = c.card;
              }}
              initial={{ opacity: 0, y: 10 }}
              animate={visible ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.7, delay: 0.15 + i * 0.06 }}
            >
              <div
                className="w-9 h-9 rounded-lg flex items-center justify-center mb-4 text-base"
                style={{
                  background: `${f.iconColor}12`,
                  border: `1px solid ${f.iconColor}25`,
                }}
              >
                {f.icon}
              </div>
              <h3 className="mb-2" style={{ fontSize: "1rem", fontWeight: 600, color: c.text }}>
                {f.title}
              </h3>
              <p className="leading-relaxed" style={{ fontSize: "0.88rem", color: c.textSec }}>
                {f.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Pricing ── */
function Pricing() {
  const { ref, visible } = useInView();
  return (
    <section
      ref={ref}
      id="pricing"
      className="py-32 px-6"
      style={{ background: c.bg, borderTop: `1px solid ${c.border}` }}
    >
      <div className="mx-auto text-center" style={{ maxWidth: 520 }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={visible ? { opacity: 1 } : {}}
          transition={{ duration: 0.7 }}
        >
          <SectionLabel>Pricing</SectionLabel>
        </motion.div>
        <motion.h2
          className="mb-4"
          style={{ fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)", fontWeight: 700, letterSpacing: "-0.03em", color: c.text }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          One price. Yours forever.
        </motion.h2>
        <motion.p
          className="mb-12"
          style={{ fontSize: "1.05rem", color: c.textSec }}
          initial={{ opacity: 0 }}
          animate={visible ? { opacity: 1 } : {}}
          transition={{ duration: 0.7, delay: 0.2 }}
        >
          No subscriptions. No tiers. No recurring charges.
        </motion.p>

        <motion.div
          className="rounded-xl p-10 text-left relative overflow-hidden"
          style={{
            border: `1px solid ${c.border}`,
            background: c.card,
          }}
          initial={{ opacity: 0, y: 12 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.25 }}
        >
          {/* gradient top accent */}
          <div
            className="absolute top-0 left-0 right-0"
            style={{ height: 2, background: "linear-gradient(90deg, #2dd4bf, #22c55e)" }}
          />

          <div className="text-center mb-8">
            <div style={{ fontSize: "3.5rem", fontWeight: 700, letterSpacing: "-0.04em", color: c.text }}>
              <span style={{ fontSize: "1.5rem", fontWeight: 400, color: c.textSec, verticalAlign: "super", marginRight: 2 }}>€</span>
              39
            </div>
            <p className="mt-1" style={{ fontSize: "0.9rem", color: c.textMuted }}>
              One-time payment · Lifetime license
            </p>
          </div>

          <ul className="space-y-3 mb-10" style={{ listStyle: "none" }}>
            {[
              "Full Endstate desktop application",
              "Activate on 3 machines",
              "All future updates included",
              "No account required — offline license key",
              "30-day money-back guarantee",
            ].map((item) => (
              <li
                key={item}
                className="flex items-center gap-3"
                style={{ fontSize: "0.92rem", color: c.textSec }}
              >
                <span style={{ color: c.green, fontWeight: 700, fontSize: "0.85rem", flexShrink: 0 }}>✓</span>
                {item}
              </li>
            ))}
          </ul>

          <a
            href="#"
            className="block w-full text-center py-3 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
            style={{ background: c.text, color: c.bg, fontSize: "1.05rem" }}
          >
            Get Endstate
          </a>
        </motion.div>
      </div>
    </section>
  );
}

/* ── Footer ── */
function EndstateFooter() {
  return (
    <footer
      className="py-16 px-6"
      style={{ background: c.bg, borderTop: `1px solid ${c.border}` }}
    >
      <div className="mx-auto flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4" style={{ maxWidth: 1100 }}>
        <p style={{ fontSize: "0.8rem", color: c.textMuted }}>
          © {new Date().getFullYear()} Substrate Systems OÜ · Tallinn, Estonia
        </p>
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
    </footer>
  );
}

/* ── Page ── */
export default function EndstatePage() {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=JetBrains+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />
      <main style={{ fontFamily: "'DM Sans', -apple-system, sans-serif", background: c.bg, minHeight: "100vh", WebkitFontSmoothing: "antialiased" }}>
        <Nav />
        <Hero />
        <Showcase />
        <HowItWorks />
        <Features />
        <Pricing />
        <EndstateFooter />
      </main>
    </>
  );
}
