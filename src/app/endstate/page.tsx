"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { BuyButton } from "./BuyButton";
import { c, fadeUp, Nav, EndstateFooter } from "./_shared";

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

/* ── Hero ── */
function Hero() {
  return (
    <section className="pt-24 sm:pt-40 pb-24 px-6" style={{ background: c.bg }}>
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
          For Windows
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
          Endstate captures your apps and optionally your settings,
          then restores them on a fresh Windows install. One scan. One file. Done.
        </motion.p>
        <motion.div className="flex justify-center gap-4 flex-wrap" {...fadeUp(0.3)}>
          <BuyButton
            className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-lg font-semibold hover:opacity-88 transition-all duration-200"
            style={{ background: c.text, color: c.bg, fontSize: "1rem" }}
          >
            Get Endstate
          </BuyButton>
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
          Scan your current machine, save your setup to a file,
          then load it on any fresh Windows install.
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
              Endstate detects every installed app on your machine and
              finds settings for supported apps. Everything gets saved
              to a single file — no manual lists required.
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
              Open your saved file on a fresh Windows install. Endstate
              shows what needs installing and what you already have.
              Choose whether to restore settings too, then hit apply.
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
    title: "Automatic app detection",
    body: "Scans your machine and finds every installed app. No manual lists, no guesswork. If it's installed, Endstate sees it.",
  },
  {
    icon: "⚙",
    iconColor: c.green,
    title: "Bring your settings",
    body: "Captures and restores settings for supported apps — VS Code, Git, PowerShell, PowerToys, and more. Opt-in per app.",
  },
  {
    icon: "📦",
    iconColor: c.blue,
    title: "Portable setup files",
    body: "Your saved setup lives as plain files in your Documents folder. Copy them, back them up, share them. No cloud account required.",
  },
  {
    icon: "🔁",
    iconColor: c.copper,
    title: "You stay in control",
    body: "Apps install one at a time. Windows asks for permission before each one — nothing installs silently. You can stop at any point.",
  },
  {
    icon: "🔍",
    iconColor: c.teal,
    title: "Preview first",
    body: "Check whether your machine matches a saved setup without changing anything. See exactly what's missing before you act.",
  },
  {
    icon: "↩",
    iconColor: c.green,
    title: "Always reversible",
    body: "Every settings restore creates a backup first. One click to revert. Nothing changes without your explicit confirmation.",
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
          Whether you just got a new laptop or you&apos;re setting up machines for a team — Endstate gets you back to work faster.
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

/* ── Contrast ── */
const contrastRows = [
  { without: "Remember every app you had", with: "One scan captures them all" },
  { without: "Hunt down every installer", with: "One file holds everything" },
  { without: "Reinstall one by one", with: "One command restores all" },
  { without: "Redo settings from scratch", with: "Settings come with it" },
  { without: "4+ hours, best case", with: "Under 10 minutes" },
];

function Contrast() {
  const { ref, visible } = useInView();
  return (
    <section
      ref={ref}
      className="py-32 px-6"
      style={{ background: c.bg, borderTop: `1px solid ${c.border}` }}
    >
      <div className="mx-auto" style={{ maxWidth: 1100 }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={visible ? { opacity: 1 } : {}}
          transition={{ duration: 0.7 }}
        >
          <SectionLabel>The difference</SectionLabel>
        </motion.div>
        <motion.h2
          className="mb-16"
          style={{ fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)", fontWeight: 700, letterSpacing: "-0.03em", color: c.text }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          What changes when you use Endstate.
        </motion.h2>

        <div className="grid md:grid-cols-2 gap-5">
          {/* Without card */}
          <motion.div
            className="rounded-xl p-8"
            style={{
              border: `1px solid ${c.border}`,
              background: `linear-gradient(135deg, rgba(200,121,65,0.04), rgba(200,121,65,0.01))`,
            }}
            initial={{ opacity: 0, x: -12 }}
            animate={visible ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <div
              className="mb-6 pb-4"
              style={{
                borderBottom: `1px solid ${c.border}`,
                fontSize: "0.8rem",
                fontWeight: 500,
                color: c.copper,
                letterSpacing: "0.1em",
                textTransform: "uppercase" as const,
              }}
            >
              Without Endstate
            </div>
            <div className="space-y-4">
              {contrastRows.map((row, i) => {
                const isLast = i === contrastRows.length - 1;
                return (
                  <div
                    key={row.without}
                    className="flex items-center gap-3"
                    style={{
                      fontSize: isLast ? "1.1rem" : "0.92rem",
                      fontWeight: isLast ? 600 : 400,
                      color: c.textMuted,
                      textDecoration: "line-through",
                      textDecorationColor: "rgba(102,102,102,0.4)",
                    }}
                  >
                    {row.without}
                  </div>
                );
              })}
            </div>
          </motion.div>

          {/* With card */}
          <motion.div
            className="rounded-xl p-8 relative overflow-hidden"
            style={{
              border: `1px solid rgba(45, 212, 191, 0.2)`,
              background: `linear-gradient(135deg, rgba(45, 212, 191, 0.06), rgba(34, 197, 94, 0.03))`,
            }}
            initial={{ opacity: 0, x: 12 }}
            animate={visible ? { opacity: 1, x: 0 } : {}}
            transition={{ duration: 0.8, delay: 0.3 }}
          >
            <div
              className="absolute top-0 left-0 right-0"
              style={{ height: 2, background: "linear-gradient(90deg, #2dd4bf, #22c55e)" }}
            />
            <div
              className="mb-6 pb-4"
              style={{
                borderBottom: `1px solid rgba(45, 212, 191, 0.15)`,
                fontSize: "0.8rem",
                fontWeight: 500,
                color: c.teal,
                letterSpacing: "0.1em",
                textTransform: "uppercase" as const,
              }}
            >
              With Endstate
            </div>
            <div className="space-y-4">
              {contrastRows.map((row, i) => {
                const isLast = i === contrastRows.length - 1;
                return (
                  <div
                    key={row.with}
                    className="flex items-center gap-3"
                    style={{
                      fontSize: isLast ? "1.1rem" : "0.92rem",
                      fontWeight: isLast ? 600 : 400,
                      color: isLast ? c.teal : c.text,
                    }}
                  >
                    <span style={{ color: c.teal, fontSize: "0.75rem", flexShrink: 0 }}>&#x2713;</span>
                    {row.with}
                  </div>
                );
              })}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ── FAQ ── */
const faqs: { q: string; a: React.ReactNode }[] = [
  {
    q: "What types of apps does Endstate detect?",
    a: "Endstate detects apps installed via traditional installers (EXE/MSI) and Microsoft Store. It uses winget under the hood to handle installs. Portable apps that aren't registered in Windows are not detected.",
  },
  {
    q: "Does it need admin rights?",
    a: "Scanning your machine doesn't require admin. Restoring apps on a new machine may need admin depending on what's being installed — Endstate will prompt you when needed.",
  },
  {
    q: "Which apps can Endstate install?",
    a: "48 apps are sandbox-validated and passing, including VS Code, Git, OBS Studio, Blender, Obsidian, Discord, KeePassXC, and more.",
  },
  {
    q: "Which app settings does it back up?",
    a: "VS Code, Git, Neovim, Windows Terminal, PowerToys, Sublime Text, Windsurf, REAPER, Espanso, Flow Launcher, mpv, and foobar2000. Settings backup is always opt-in \u2014 never automatic.",
  },
  {
    q: "Can I use it across multiple machines?",
    a: "Yes. Your license covers up to 3 machines. Save your setup from any of them and restore on any other.",
  },
  {
    q: "What if something goes wrong during restore?",
    a: "Endstate creates a backup before changing any settings. You can revert with one click. App installs use standard Windows installers, so they can be uninstalled normally.",
  },
  {
    q: "Is an internet connection required?",
    a: "Scanning and saving your setup works offline. Restoring apps on a new machine needs internet to download installers. License activation is a one-time online check.",
  },
  {
    q: "Is this safe to run on my machine?",
    a: (
      <>
        The provisioning engine — the part that actually installs software — is{" "}
        <a
          href="https://github.com/Artexis10/endstate"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2dd4bf", textDecoration: "none" }}
        >
          open source
        </a>
        . You can read exactly what it does before running anything. The GUI is a
        commercial product built on top of it.{" "}
        <a
          href="https://github.com/Artexis10/endstate"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#2dd4bf", textDecoration: "none" }}
        >
          View engine on GitHub →
        </a>
      </>
    ),
  },
];

function FAQ() {
  const { ref, visible } = useInView();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  return (
    <section
      ref={ref}
      id="faq"
      className="py-32 px-6"
      style={{ background: c.bg, borderTop: `1px solid ${c.border}` }}
    >
      <div className="mx-auto" style={{ maxWidth: 700 }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={visible ? { opacity: 1 } : {}}
          transition={{ duration: 0.7 }}
        >
          <SectionLabel>FAQ</SectionLabel>
        </motion.div>
        <motion.h2
          className="mb-12"
          style={{ fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)", fontWeight: 700, letterSpacing: "-0.03em", color: c.text }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          Common questions
        </motion.h2>

        <div className="space-y-0">
          {faqs.map((faq, i) => (
            <motion.div
              key={faq.q}
              initial={{ opacity: 0, y: 8 }}
              animate={visible ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.6, delay: 0.15 + i * 0.05 }}
              style={{ borderBottom: `1px solid ${c.border}` }}
            >
              <button
                className="w-full flex items-center justify-between py-5 text-left"
                style={{ background: "transparent", border: "none", cursor: "pointer" }}
                onClick={() => setOpenIndex(openIndex === i ? null : i)}
              >
                <span style={{ fontSize: "0.95rem", fontWeight: 500, color: c.text, paddingRight: 16 }}>
                  {faq.q}
                </span>
                <span
                  style={{
                    color: c.textMuted,
                    fontSize: "1.2rem",
                    flexShrink: 0,
                    transition: "transform 0.2s ease",
                    transform: openIndex === i ? "rotate(45deg)" : "rotate(0deg)",
                  }}
                >
                  +
                </span>
              </button>
              <div
                style={{
                  overflow: "hidden",
                  maxHeight: openIndex === i ? 200 : 0,
                  transition: "max-height 0.3s ease",
                }}
              >
                <p
                  className="pb-5"
                  style={{ fontSize: "0.9rem", color: c.textSec, lineHeight: 1.7 }}
                >
                  {faq.a}
                </p>
              </div>
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
              "Full Endstate desktop app",
              "Use on up to 3 machines",
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

          <BuyButton
            className="block w-full text-center py-3 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
            style={{ background: c.text, color: c.bg, fontSize: "1.05rem" }}
          >
            Get Endstate
          </BuyButton>
        </motion.div>
      </div>
    </section>
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
        <Contrast />
        <FAQ />
        <Pricing />
        <EndstateFooter />
      </main>
    </>
  );
}
