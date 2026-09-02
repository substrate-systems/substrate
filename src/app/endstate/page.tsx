"use client";

import { motion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Zap,
  SlidersHorizontal,
  Package,
  ShieldCheck,
  ScanSearch,
  Undo2,
  FileDown,
  type LucideIcon,
} from "lucide-react";
import { c, fadeUp, Nav, EndstateFooter } from "./_shared";
import { GithubMark } from "@/components/GithubMark";
import { BuyButton } from "./BuyButton";
import { PaddleTransactionOpener } from "./PaddleTransactionOpener";
import { usePaddle, type HostedBackupCadence } from "@/lib/paddle";
import { lowestSupportAmount } from "@/lib/support-tiers";
import { siteConfig } from "@/lib/seo";
import { faqs } from "./faq-data";

const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Endstate",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Windows",
  description:
    "Reinstall your apps and restore your settings on a new Windows PC. Scan your current machine, save a portable setup file, then restore everything on a fresh install in minutes.",
  url: `${siteConfig.url}/endstate`,
  downloadUrl: `${siteConfig.url}/download`,
  installUrl: `${siteConfig.url}/download`,
  screenshot: [
    `${siteConfig.url}/endstate/01-landing.png`,
    `${siteConfig.url}/endstate/02-save-results.png`,
    `${siteConfig.url}/endstate/03-setup-results.png`,
  ],
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
  license: `${siteConfig.url}/terms`,
  sameAs: ["https://github.com/Artexis10/endstate"],
  // `codeRepository` and `programmingLanguage` are SoftwareSourceCode properties, not
  // SoftwareApplication ones — emitting them on the app made the whole item invalid,
  // the same way a missing Article `image` did. The engine is the canonical artifact
  // the app is built on, so isBasedOn is both valid and accurate.
  isBasedOn: {
    "@type": "SoftwareSourceCode",
    name: "Endstate provisioning engine",
    description:
      "Open-source Go CLI that performs app detection, installation, and settings backup and restore on Windows via winget.",
    codeRepository: "https://github.com/Artexis10/endstate",
    programmingLanguage: "Go",
    license: "https://www.apache.org/licenses/LICENSE-2.0",
  },
};

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((faq) => ({
    "@type": "Question",
    name: faq.q,
    acceptedAnswer: {
      "@type": "Answer",
      text: typeof faq.a === "string" ? faq.a : (faq.aText ?? ""),
    },
  })),
};

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useInView(options = { threshold: 0.15 }) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), options);
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, []);
  return { ref, visible };
}

/* ── Global styles: hero underline draw, signature grid, tile hover, focus ── */
function ElevationStyles() {
  return (
    <style>{`
      @keyframes esUnderline { from { background-size: 0% 0.09em; } to { background-size: 100% 0.09em; } }
      .es-underline {
        background-image: linear-gradient(90deg, #2dd4bf, #22c55e);
        background-repeat: no-repeat;
        background-position: 0% 100%;
        background-size: 100% 0.09em;
        padding-bottom: 0.06em;
        animation: esUnderline 1.1s cubic-bezier(0.16, 1, 0.3, 1) 0.5s backwards;
      }
      .es-sig { display: grid; grid-template-columns: 1fr 104px 1fr; align-items: stretch; }
      .es-sig-conn { position: relative; display: flex; align-items: center; justify-content: center; min-height: 64px; }
      .es-card:hover .es-tile { filter: brightness(1.4); }
      a:focus-visible, button:focus-visible { outline: 2px solid rgba(255,255,255,0.4); outline-offset: 3px; }
      @media (max-width: 720px) {
        .es-sig { grid-template-columns: 1fr; }
        .es-sig-conn { height: 88px; }
      }
      @media (prefers-reduced-motion: reduce) {
        .es-underline { animation: none; }
      }
    `}</style>
  );
}

/* ── Signature moment: live "Save → Set up" animation ── */
const SIG_APPS = [
  { name: "VS Code", source: "winget" },
  { name: "Git", source: "winget" },
  { name: "Blender", source: "winget" },
  { name: "OBS Studio", source: "winget" },
  { name: "Obsidian", source: "msstore" },
  { name: "Discord", source: "winget" },
];

function SignatureMoment() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sig = rootRef.current;
    if (!sig) return;
    const q = (s: string) => sig.querySelector(s) as HTMLElement | null;
    const qa = (s: string) => Array.from(sig.querySelectorAll(s)) as HTMLElement[];
    const el = {
      aRows: qa("[data-smarow]"),
      aDots: qa("[data-smadot]"),
      bRows: qa("[data-smbrow]"),
      bChecks: qa("[data-smbcheck]"),
      apps: q("#smApps"),
      sets: q("#smSet"),
      scanLabel: q("#smScanLabel"),
      bLabel: q("#smBLabel"),
      chip: q("#smChip"),
      fill: q("#smLineFill"),
      done: q("#smDone"),
    };
    if (!el.apps || !el.sets || !el.scanLabel || !el.bLabel || !el.chip || !el.fill || !el.done)
      return;
    const N = el.aRows.length;
    const clamp = (x: number) => Math.max(0, Math.min(1, x));
    const ease = (x: number) => 1 - Math.pow(1 - x, 3);

    const setStatic = () => {
      el.apps!.textContent = "81";
      el.sets!.textContent = "8";
      el.scanLabel!.textContent = "SAVED";
      el.scanLabel!.style.color = "#22c55e";
      el.aRows.forEach((r) => (r.style.opacity = "1"));
      el.aDots.forEach((d) => (d.style.background = "#2dd4bf"));
      el.fill!.style.width = "100%";
      el.chip!.style.opacity = "1";
      el.chip!.style.transform = "translateX(0px)";
      el.bRows.forEach((r) => (r.style.opacity = "1"));
      el.bChecks.forEach((chk) => (chk.style.opacity = "1"));
      el.bLabel!.textContent = "READY";
      el.bLabel!.style.color = "#22c55e";
      el.done!.style.opacity = "1";
    };

    if (prefersReducedMotion()) {
      setStatic();
      return;
    }

    let visible = false;
    const sigIo = new IntersectionObserver((es) => (visible = es[0].isIntersecting), {
      threshold: 0.2,
    });
    sigIo.observe(sig);

    const DUR = 9.5;
    let elapsed = 0;
    let last: number | null = null;
    let raf = 0;

    const travelDist = () => {
      const conn = sig.querySelector(".es-sig-conn") as HTMLElement | null;
      return conn ? Math.max(40, conn.offsetWidth / 2 + 10) : 62;
    };

    const apply = (t: number) => {
      const scanP = clamp(t / 2.6);
      el.apps!.textContent = String(Math.round(ease(scanP) * 81));
      el.sets!.textContent = String(Math.round(ease(scanP) * 8));
      el.aRows.forEach((r, i) => {
        const on = scanP >= (i + 1) / N - 0.001;
        r.style.opacity = on ? "1" : "0.4";
        if (el.aDots[i]) el.aDots[i].style.background = on ? "#2dd4bf" : "#3a3a3a";
      });
      el.scanLabel!.textContent = t < 2.6 ? "SCANNING" : "SAVED";
      el.scanLabel!.style.color = t < 2.6 ? "#2dd4bf" : "#22c55e";

      let chipO = t >= 2.6 ? clamp((t - 2.6) / 0.4) : 0;
      const trav = clamp((t - 3.2) / 1.3);
      if (t > 4.7) chipO = 1 - clamp((t - 4.7) / 0.4);
      const D = travelDist();
      el.chip!.style.opacity = String(chipO);
      el.chip!.style.transform = "translateX(" + (-D + ease(trav) * 2 * D).toFixed(1) + "px)";
      el.fill!.style.width = (ease(trav) * 100).toFixed(1) + "%";

      const restoreStart = 4.7;
      el.bRows.forEach((r, i) => {
        const on = t >= restoreStart + i * 0.22;
        r.style.opacity = on ? "1" : "0.25";
        if (el.bChecks[i]) el.bChecks[i].style.opacity = on ? "1" : "0";
      });
      const restoreEnd = restoreStart + N * 0.22;
      if (t < 4.5) {
        el.bLabel!.textContent = "WAITING";
        el.bLabel!.style.color = "#666";
      } else if (t < restoreEnd) {
        el.bLabel!.textContent = "RESTORING";
        el.bLabel!.style.color = "#2dd4bf";
      } else {
        el.bLabel!.textContent = "READY";
        el.bLabel!.style.color = "#22c55e";
      }
      el.done!.style.opacity = String(clamp((t - restoreEnd - 0.2) / 0.5));

      sig.style.opacity = t > DUR - 0.35 ? String(clamp((DUR - t) / 0.35)) : "1";
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible) {
        last = null;
        return;
      }
      if (last == null) last = now;
      elapsed += (now - last) / 1000;
      last = now;
      apply(elapsed % DUR);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      sigIo.disconnect();
    };
  }, []);

  const rowBase: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 0",
    fontSize: "0.82rem",
    color: "#c0c0c0",
  };
  const mono = "var(--font-jetbrains-mono), monospace";
  const cardShell: React.CSSProperties = {
    background: c.elevated,
    border: `1px solid ${c.border}`,
    borderRadius: 12,
    overflow: "hidden",
  };
  const headerRow: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 18px",
    borderBottom: `1px solid ${c.border}`,
  };
  const headerLabel: React.CSSProperties = {
    fontFamily: mono,
    fontSize: "0.65rem",
    fontWeight: 500,
    letterSpacing: "0.12em",
  };

  return (
    <div
      ref={rootRef}
      id="sig"
      role="img"
      aria-label="Endstate scans a machine, detects 81 apps and 8 settings, saves them to one portable file, and restores them on a new machine in minutes."
      style={{ maxWidth: 960, margin: "88px auto 0" }}
    >
      <div className="es-sig" aria-hidden="true">
        {/* THIS MACHINE */}
        <div style={cardShell}>
          <div style={headerRow}>
            <span style={{ ...headerLabel, color: c.textMuted }}>THIS MACHINE</span>
            <span id="smScanLabel" style={{ ...headerLabel, color: c.teal }}>
              SCANNING
            </span>
          </div>
          <div style={{ padding: "10px 18px 8px" }}>
            {SIG_APPS.map((app, i) => (
              <div key={app.name} data-smarow={i} style={{ ...rowBase, opacity: 0.4 }}>
                <span
                  data-smadot={i}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#3a3a3a",
                    flexShrink: 0,
                  }}
                />
                {app.name}
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: mono,
                    fontSize: "0.62rem",
                    color: c.textMuted,
                  }}
                >
                  {app.source}
                </span>
              </div>
            ))}
            <div style={{ ...rowBase, color: c.textMuted, opacity: 0.5 }}>
              <span style={{ width: 6, height: 6, flexShrink: 0 }} />+ 75 more
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 5,
              padding: "12px 18px",
              borderTop: `1px solid ${c.border}`,
              fontFamily: mono,
              fontSize: "0.72rem",
            }}
          >
            <span id="smApps" style={{ color: c.teal, fontWeight: 500 }}>
              0
            </span>
            <span style={{ color: c.textMuted }}>apps ·</span>
            <span id="smSet" style={{ color: c.teal, fontWeight: 500 }}>
              0
            </span>
            <span style={{ color: c.textMuted }}>settings detected</span>
          </div>
        </div>

        {/* Connector */}
        <div className="es-sig-conn">
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: "50%",
              height: 2,
              background: "#222",
            }}
          />
          <div
            id="smLineFill"
            style={{
              position: "absolute",
              left: 0,
              top: "50%",
              height: 2,
              width: "0%",
              background: "linear-gradient(90deg, #2dd4bf, #22c55e)",
            }}
          />
          <div
            id="smChip"
            style={{
              position: "relative",
              zIndex: 1,
              display: "flex",
              alignItems: "center",
              gap: 6,
              opacity: 0,
              background: c.card,
              border: "1px solid rgba(45, 212, 191, 0.45)",
              borderRadius: 6,
              padding: "6px 10px",
              fontFamily: mono,
              fontSize: "0.65rem",
              color: c.teal,
              whiteSpace: "nowrap",
              boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            }}
          >
            <FileDown size={12} aria-hidden="true" />
            setup.zip
          </div>
        </div>

        {/* NEW MACHINE */}
        <div style={cardShell}>
          <div style={headerRow}>
            <span style={{ ...headerLabel, color: c.textMuted }}>NEW MACHINE</span>
            <span id="smBLabel" style={{ ...headerLabel, color: c.textMuted }}>
              WAITING
            </span>
          </div>
          <div style={{ padding: "10px 18px 8px" }}>
            {SIG_APPS.map((app, i) => (
              <div key={app.name} data-smbrow={i} style={{ ...rowBase, opacity: 0.25 }}>
                {app.name}
                <span
                  data-smbcheck={i}
                  style={{
                    marginLeft: "auto",
                    color: c.teal,
                    fontSize: "0.75rem",
                    fontWeight: 700,
                    opacity: 0,
                  }}
                >
                  ✓
                </span>
              </div>
            ))}
            <div style={{ ...rowBase, color: c.textMuted, opacity: 0.5 }}>+ 75 more</div>
          </div>
          <div style={{ padding: "12px 18px", borderTop: `1px solid ${c.border}` }}>
            <span
              id="smDone"
              style={{ fontFamily: mono, fontSize: "0.72rem", color: c.green, opacity: 0 }}
            >
              Ready in minutes, not a weekend.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Hero ── */
function Hero() {
  return (
    <section className="pt-24 sm:pt-40 pb-24 px-6" style={{ background: c.bg }}>
      <div className="mx-auto max-w-3xl text-center">
        <motion.span
          className="inline-block rounded-full mb-8"
          style={{
            fontFamily: "var(--font-jetbrains-mono), monospace",
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
            lineHeight: 1.12,
            letterSpacing: "-0.035em",
            color: c.text,
          }}
          {...fadeUp(0.1)}
        >
          Spent a weekend setting up your last laptop?
          <br />
          <span className="es-underline">Don&apos;t do it again.</span>
        </motion.h1>
        <motion.p
          className="mx-auto mb-10"
          style={{ fontSize: "1.2rem", color: c.textSec, maxWidth: 600, lineHeight: 1.7 }}
          {...fadeUp(0.2)}
        >
          Endstate captures the apps and settings that make your Windows machine yours, then puts
          them back on the next one in minutes. Free, open source, your data stays yours.
        </motion.p>
        <motion.div className="flex justify-center gap-4 flex-wrap" {...fadeUp(0.3)}>
          <Link
            href="/download"
            className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-lg font-semibold hover:opacity-88 transition-all duration-200"
            style={{ background: c.text, color: c.bg, fontSize: "1rem", textDecoration: "none" }}
          >
            Download free
          </Link>
          <a
            href="https://github.com/Artexis10/endstate"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-lg font-semibold transition-all duration-200"
            style={{
              background: "transparent",
              color: c.text,
              border: `1px solid ${c.border}`,
              fontSize: "1rem",
              textDecoration: "none",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = c.borderAccent)}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = c.border)}
          >
            <GithubMark size={17} />
            View on GitHub
          </a>
        </motion.div>
        <motion.p
          className="mt-4"
          style={{ fontSize: "0.85rem", color: c.textMuted }}
          {...fadeUp(0.4)}
        >
          Free forever ·{" "}
          <strong style={{ color: c.textSec, fontWeight: 600 }}>Open source engine</strong> · No
          account required
        </motion.p>
      </div>

      <SignatureMoment />
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
      <motion.p
        className="text-center mt-5"
        style={{
          fontFamily: "var(--font-jetbrains-mono), monospace",
          fontSize: "0.68rem",
          letterSpacing: "0.12em",
          color: c.textMuted,
        }}
        initial={{ opacity: 0, y: 8 }}
        animate={visible ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
      >
        ONE WINDOW · TWO JOBS · EVERYTHING LOCAL
      </motion.p>
    </section>
  );
}

/* ── Section label ── */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="block uppercase mb-3"
      style={{
        fontFamily: "var(--font-jetbrains-mono), monospace",
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
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = threadRef.current;
    if (!container) return;
    const threads = Array.from(container.querySelectorAll("[data-thread]")) as HTMLElement[];
    if (!threads.length) return;
    threads.forEach((t) => {
      t.style.transformOrigin = t.getAttribute("data-thread") === "l" ? "100% 50%" : "0% 50%";
    });
    if (prefersReducedMotion()) {
      threads.forEach((t) => (t.style.transform = "scaleX(1)"));
      return;
    }
    threads.forEach((t) => (t.style.transform = "scaleX(0)"));
    const io = new IntersectionObserver(
      (es) => {
        if (!es[0].isIntersecting) return;
        threads.forEach((t) => {
          t.style.transition = "transform 0.9s cubic-bezier(0.16, 1, 0.3, 1) 200ms";
          t.style.transform = "scaleX(1)";
        });
        io.disconnect();
      },
      { threshold: 0.5 }
    );
    io.observe(container);
    return () => io.disconnect();
  }, []);

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
          style={{
            fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: c.text,
          }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          Two screens. Zero guesswork.
        </motion.h2>
        <motion.p
          className="mb-10"
          style={{ fontSize: "1.05rem", color: c.textSec, maxWidth: 600, lineHeight: 1.7 }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          Scan your current machine, save your setup to a file you control, then load it on any
          fresh Windows install. Everything runs locally.
        </motion.p>

        {/* Portable-file thread */}
        <div ref={threadRef} className="flex items-center gap-4 mb-10" aria-hidden="true">
          <div
            data-thread="l"
            style={{
              flex: 1,
              height: 1,
              background: "linear-gradient(90deg, transparent, rgba(45,212,191,0.35))",
            }}
          />
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--font-jetbrains-mono), monospace",
              fontSize: "0.65rem",
              color: c.teal,
              border: "1px solid rgba(45,212,191,0.3)",
              borderRadius: 6,
              padding: "5px 10px",
              background: "rgba(45,212,191,0.05)",
              whiteSpace: "nowrap",
            }}
          >
            <FileDown size={12} aria-hidden="true" />
            one portable file carries it
          </span>
          <div
            data-thread="r"
            style={{
              flex: 1,
              height: 1,
              background: "linear-gradient(90deg, rgba(34,197,94,0.35), transparent)",
            }}
          />
        </div>

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
                fontFamily: "var(--font-jetbrains-mono), monospace",
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
              Endstate detects every installed app on your machine and finds settings for supported
              apps. Everything gets saved to a single file — no manual lists required.
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
            <div
              style={{
                marginTop: 12,
                fontFamily: "var(--font-jetbrains-mono), monospace",
                fontSize: "0.65rem",
                letterSpacing: "0.08em",
                color: c.textMuted,
              }}
            >
              81 APPS DETECTED · 8 SETTINGS CAPTURED
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
                fontFamily: "var(--font-jetbrains-mono), monospace",
                fontSize: "0.7rem",
                fontWeight: 500,
                color: c.green,
                letterSpacing: "0.12em",
              }}
            >
              02 — Set up
            </span>
            <h3 className="mb-3" style={{ fontSize: "1.3rem", fontWeight: 600, color: c.text }}>
              Restore on a new machine
            </h3>
            <p className="mb-6" style={{ fontSize: "0.95rem", color: c.textSec, lineHeight: 1.7 }}>
              Open your saved file on a fresh Windows install. Endstate shows what needs installing
              and what you already have. Choose whether to restore settings too, then hit apply.
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
            <div
              style={{
                marginTop: 12,
                fontFamily: "var(--font-jetbrains-mono), monospace",
                fontSize: "0.65rem",
                letterSpacing: "0.08em",
                color: c.textMuted,
              }}
            >
              3 TO INSTALL · 69 ALREADY PRESENT
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/* ── Features ── */
const features: {
  Icon: LucideIcon;
  iconColor: string;
  title: string;
  body: string;
}[] = [
  {
    Icon: Zap,
    iconColor: c.teal,
    title: "Automatic app detection",
    body: "Scans your machine and finds every installed app, then reinstalls anything winget can — thousands of apps. No manual lists, no guesswork. If it's installed, Endstate sees it.",
  },
  {
    Icon: SlidersHorizontal,
    iconColor: c.green,
    title: "Bring your settings",
    body: "Captures and restores settings for 300+ apps — editors, terminals, creative tools, emulators, and more. Opt-in per app.",
  },
  {
    Icon: Package,
    iconColor: c.blue,
    title: "Portable setup files",
    body: "Your saved setup lives as plain files in your Documents folder. Copy them, back them up, share them. No cloud account required.",
  },
  {
    Icon: ShieldCheck,
    iconColor: c.copper,
    title: "You stay in control",
    body: "Apps install one at a time. Windows asks for permission before each one — nothing installs silently. You can stop at any point.",
  },
  {
    Icon: ScanSearch,
    iconColor: c.teal,
    title: "Preview first",
    body: "Check whether your machine matches a saved setup without changing anything. See exactly what's missing before you act.",
  },
  {
    Icon: Undo2,
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
          style={{
            fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: c.text,
          }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          Built for the people who actually use their machines.
        </motion.h2>
        <motion.p
          className="mb-16"
          style={{ fontSize: "1.05rem", color: c.textSec, maxWidth: 600, lineHeight: 1.7 }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.15 }}
        >
          Designers, editors, creators, gamers, freelancers, students, sysadmins — anyone whose
          laptop is full of carefully chosen tools and settings. Endstate gets you back to work in
          minutes, not a weekend.
        </motion.p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((f, i) => (
            <motion.div
              key={f.title}
              className="es-card p-6 rounded-lg transition-colors duration-200"
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
                className="es-tile w-9 h-9 rounded-lg flex items-center justify-center mb-4"
                style={{
                  background: `${f.iconColor}14`,
                  border: `1px solid ${f.iconColor}40`,
                  color: f.iconColor,
                  transition: "filter 200ms ease",
                }}
              >
                <f.Icon size={18} aria-hidden="true" />
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

        <div style={{ marginTop: "2.5rem" }}>
          <a
            href="/endstate/apps"
            style={{ fontSize: "0.95rem", color: c.teal, textDecoration: "none" }}
          >
            See the 300+ apps with settings support →
          </a>
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
  const withoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = withoutRef.current;
    if (!card) return;
    const strikes = Array.from(card.querySelectorAll("[data-strike]")) as HTMLElement[];
    if (!strikes.length) return;
    if (prefersReducedMotion()) {
      strikes.forEach((s) => (s.style.width = "100%"));
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (!es[0].isIntersecting) return;
        strikes.forEach((s, i) => {
          s.style.transition =
            "width 0.45s cubic-bezier(0.33, 1, 0.68, 1) " + (400 + i * 260) + "ms";
          s.style.width = "100%";
        });
        io.disconnect();
      },
      { threshold: 0.4 }
    );
    io.observe(card);
    return () => io.disconnect();
  }, []);

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
          style={{
            fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: c.text,
          }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          What changes when you use Endstate.
        </motion.h2>

        <div className="grid md:grid-cols-2 gap-5">
          {/* Without card */}
          <motion.div
            ref={withoutRef}
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
                    style={{
                      fontSize: isLast ? "1.1rem" : "0.92rem",
                      fontWeight: isLast ? 600 : 400,
                      color: c.textMuted,
                    }}
                  >
                    <span style={{ position: "relative", display: "inline-block" }}>
                      {row.without}
                      <span
                        data-strike={i}
                        style={{
                          position: "absolute",
                          left: 0,
                          top: "52%",
                          height: isLast ? 1.5 : 1,
                          width: "0%",
                          background: isLast ? "rgba(200,121,65,0.6)" : "rgba(153,153,153,0.6)",
                        }}
                      />
                    </span>
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
                    <span style={{ color: c.teal, fontSize: "0.75rem", flexShrink: 0 }}>
                      &#x2713;
                    </span>
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
          style={{
            fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: c.text,
          }}
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
                <span
                  style={{ fontSize: "0.95rem", fontWeight: 500, color: c.text, paddingRight: 16 }}
                >
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
                  maxHeight: openIndex === i ? 520 : 0,
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
type PricingTier = {
  name: string;
  price: React.ReactNode;
  cadence: string;
  blurb: string;
  features: string[];
  cta: {
    label: string;
    href?: string;
    primary?: boolean;
    external?: boolean;
    // `paddle-hosted-backup` is a deliberately retained internal discriminant;
    // the tier it drives is called Endstate Cloud in public copy.
    kind?: "paddle-hosted-backup";
  };
  badge?: string;
  highlight?: boolean;
  cadenceToggle?: React.ReactNode;
};

function HostedBackupCadenceToggle({
  cadence,
  onChange,
}: {
  cadence: HostedBackupCadence;
  onChange: (next: HostedBackupCadence) => void;
}) {
  const optionBase: React.CSSProperties = {
    fontFamily: "var(--font-jetbrains-mono), monospace",
    fontSize: "0.7rem",
    fontWeight: 500,
    padding: "0.3rem 0.65rem",
    borderRadius: 4,
    cursor: "pointer",
    border: "none",
    background: "transparent",
    color: c.textSec,
    letterSpacing: "0.02em",
    textTransform: "uppercase",
    transition: "background 120ms ease, color 120ms ease",
  };
  const activeStyle: React.CSSProperties = {
    background: "rgba(200,121,65,0.12)",
    color: c.copper,
  };
  return (
    <div
      role="radiogroup"
      aria-label="Endstate Cloud billing cadence"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: 3,
        border: `1px solid ${c.border}`,
        borderRadius: 6,
        marginBottom: "0.75rem",
      }}
    >
      <button
        type="button"
        role="radio"
        aria-checked={cadence === "monthly"}
        onClick={() => onChange("monthly")}
        style={{
          ...optionBase,
          ...(cadence === "monthly" ? activeStyle : {}),
        }}
      >
        Monthly
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={cadence === "yearly"}
        onClick={() => onChange("yearly")}
        style={{
          ...optionBase,
          ...(cadence === "yearly" ? activeStyle : {}),
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        Yearly
        <span
          style={{
            fontSize: "0.6rem",
            fontWeight: 500,
            color: c.green,
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          save 17%
        </span>
      </button>
    </div>
  );
}

function Pricing() {
  const { ref, visible } = useInView();
  const { openHostedBackupCheckout } = usePaddle();
  const [hostedBackupCadence, setHostedBackupCadence] = useState<HostedBackupCadence>("monthly");

  const hostedBackupPrice =
    hostedBackupCadence === "monthly" ? (
      <>
        <span
          style={{
            fontSize: "1.5rem",
            fontWeight: 400,
            color: c.textSec,
            verticalAlign: "super",
            marginRight: 2,
          }}
        >
          €
        </span>
        <span
          style={{ fontSize: "3.5rem", fontWeight: 700, letterSpacing: "-0.04em", color: c.text }}
        >
          4
        </span>
        <span style={{ fontSize: "1rem", fontWeight: 400, color: c.textSec, marginLeft: 4 }}>
          /mo
        </span>
      </>
    ) : (
      <>
        <span
          style={{
            fontSize: "1.5rem",
            fontWeight: 400,
            color: c.textSec,
            verticalAlign: "super",
            marginRight: 2,
          }}
        >
          €
        </span>
        <span
          style={{ fontSize: "3.5rem", fontWeight: 700, letterSpacing: "-0.04em", color: c.text }}
        >
          40
        </span>
        <span style={{ fontSize: "1rem", fontWeight: 400, color: c.textSec, marginLeft: 4 }}>
          /yr
        </span>
      </>
    );
  const hostedBackupCadenceLabel =
    hostedBackupCadence === "monthly"
      ? "Billed monthly · Cancel any time"
      : "Billed yearly · Cancel any time";
  const hostedBackupCtaLabel =
    hostedBackupCadence === "monthly"
      ? "Get Endstate Cloud — €4/mo"
      : "Get Endstate Cloud — €40/yr";
  const supportFromAmount = lowestSupportAmount();

  const tiers: PricingTier[] = [
    {
      name: "Free",
      price: (
        <>
          <span
            style={{ fontSize: "3.5rem", fontWeight: 700, letterSpacing: "-0.04em", color: c.text }}
          >
            €0
          </span>
        </>
      ),
      cadence: "Forever · No account",
      blurb: "The full Endstate product — every feature, no limits.",
      features: [
        "Full GUI and CLI",
        "Capture, restore, profiles, manifests",
        "Settings backup for supported apps",
        "Back up to any location you control",
        "Open source engine (Apache 2.0)",
        "Works fully offline",
      ],
      cta: { label: "Download free", href: "/download", primary: true },
      highlight: true,
    },
    {
      name: "Endstate Cloud",
      price: hostedBackupPrice,
      cadence: hostedBackupCadenceLabel,
      blurb: "Your encrypted setup history, ready on another Windows PC.",
      features: [
        "Endstate application lists and supported non-secret settings, encrypted before upload",
        "Endstate Cloud protects the application list and supported non-secret settings captured by Endstate; it is not personal-file backup.",
        "Client-side keys — Endstate cannot read your data",
        "Keep protected versions without managing storage yourself",
        "Restore your Endstate setup on another Windows PC",
        "Self-hosting protocol stays open",
        "Cancel any time",
      ],
      cta: {
        label: hostedBackupCtaLabel,
        kind: "paddle-hosted-backup",
      },
      cadenceToggle: (
        <HostedBackupCadenceToggle
          cadence={hostedBackupCadence}
          onChange={setHostedBackupCadence}
        />
      ),
    },
    {
      name: "Support Endstate",
      price: (
        <>
          <span style={{ fontSize: "1.1rem", fontWeight: 400, color: c.textSec, marginRight: 6 }}>
            from
          </span>
          <span
            style={{
              fontSize: "3.5rem",
              fontWeight: 700,
              letterSpacing: "-0.04em",
              color: c.text,
            }}
          >
            {supportFromAmount}
          </span>
        </>
      ),
      cadence: "One-time · Entirely optional",
      blurb:
        "Not a plan. Endstate is already free and complete — this is for people who want the project to keep going.",
      features: [
        "Unlocks nothing: there is nothing held back",
        "Your name on the supporters page (opt-in)",
        "Your name in the open-source repository (opt-in)",
        "Funds ongoing development",
        "That's the whole pitch — be honest with yourself",
      ],
      cta: {
        label: "Choose an amount",
        href: "/endstate/supporters#support",
      },
    },
    {
      name: "Endstate for Teams",
      price: (
        <span style={{ fontSize: "1.5rem", fontWeight: 500, color: c.textSec }}>
          Design partner research
        </span>
      ),
      cadence: "Speaking with design partners",
      blurb:
        "We are exploring how Endstate could support repeatable Windows setup and recovery for organisations.",
      features: ["Speaking with design partners", "No current team product or purchase"],
      cta: {
        label: "Talk to us",
        href: "mailto:founder@substratesystems.io?subject=Endstate%20Teams%20%E2%80%94%20interested",
      },
      badge: "Research",
    },
  ];

  return (
    <section
      ref={ref}
      id="pricing"
      className="py-32 px-6"
      style={{ background: c.bg, borderTop: `1px solid ${c.border}` }}
    >
      <div className="mx-auto" style={{ maxWidth: 1100 }}>
        <div className="text-center mb-12">
          <motion.div
            initial={{ opacity: 0 }}
            animate={visible ? { opacity: 1 } : {}}
            transition={{ duration: 0.7 }}
          >
            <SectionLabel>Pricing</SectionLabel>
          </motion.div>
          <motion.h2
            className="mb-4"
            style={{
              fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)",
              fontWeight: 700,
              letterSpacing: "-0.03em",
              color: c.text,
            }}
            initial={{ opacity: 0, y: 8 }}
            animate={visible ? { opacity: 1, y: 0 } : {}}
            transition={{ duration: 0.8, delay: 0.1 }}
          >
            Free product. Optional paid services.
          </motion.h2>
          <motion.p
            style={{ fontSize: "1.05rem", color: c.textSec, maxWidth: 600, margin: "0 auto" }}
            initial={{ opacity: 0 }}
            animate={visible ? { opacity: 1 } : {}}
            transition={{ duration: 0.7, delay: 0.2 }}
          >
            The local product is free, forever. Pay only for managed services you actually want, or
            chip in if you want to support the project.
          </motion.p>
        </div>

        <div className="grid sm:grid-cols-2 gap-5">
          {tiers.map((tier, i) => (
            <motion.div
              key={tier.name}
              className="rounded-xl p-8 relative overflow-hidden flex flex-col"
              style={{
                border: tier.highlight
                  ? `1px solid rgba(45, 212, 191, 0.25)`
                  : `1px solid ${c.border}`,
                background: tier.highlight
                  ? `linear-gradient(180deg, rgba(45, 212, 191, 0.04), rgba(34, 197, 94, 0.015))`
                  : c.card,
              }}
              initial={{ opacity: 0, y: 12 }}
              animate={visible ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.8, delay: 0.2 + i * 0.1 }}
            >
              {tier.highlight && (
                <div
                  className="absolute top-0 left-0 right-0"
                  style={{ height: 2, background: "linear-gradient(90deg, #2dd4bf, #22c55e)" }}
                />
              )}

              <div className="mb-2 flex items-center gap-2">
                <h3 style={{ fontSize: "1.05rem", fontWeight: 600, color: c.text }}>{tier.name}</h3>
                {tier.badge && (
                  <span
                    style={{
                      fontFamily: "var(--font-jetbrains-mono), monospace",
                      fontSize: "0.65rem",
                      fontWeight: 500,
                      color: c.copper,
                      border: `1px solid rgba(200,121,65,0.3)`,
                      background: "rgba(200,121,65,0.05)",
                      padding: "0.15rem 0.5rem",
                      borderRadius: "4px",
                      letterSpacing: "0.05em",
                      textTransform: "uppercase",
                    }}
                  >
                    {tier.badge}
                  </span>
                )}
              </div>

              {tier.cadenceToggle}
              <div style={{ marginBottom: "0.25rem" }}>{tier.price}</div>
              <p style={{ fontSize: "0.82rem", color: c.textMuted, marginBottom: "1rem" }}>
                {tier.cadence}
              </p>
              <p
                style={{
                  fontSize: "0.92rem",
                  color: c.textSec,
                  lineHeight: 1.6,
                  marginBottom: "1.5rem",
                }}
              >
                {tier.blurb}
              </p>

              <ul className="space-y-2 mb-8 flex-1" style={{ listStyle: "none" }}>
                {tier.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-3"
                    style={{ fontSize: "0.88rem", color: c.textSec, lineHeight: 1.5 }}
                  >
                    <span
                      style={{
                        color: c.green,
                        fontWeight: 700,
                        fontSize: "0.8rem",
                        flexShrink: 0,
                        marginTop: 2,
                      }}
                    >
                      ✓
                    </span>
                    {f}
                  </li>
                ))}
              </ul>

              {tier.cta.kind === "paddle-hosted-backup" ? (
                <BuyButton
                  product="hosted_backup"
                  action={() => openHostedBackupCheckout(hostedBackupCadence)}
                  completionLabel="Thanks — check your email to finish setup."
                  className="block w-full text-center py-2.5 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
                  style={{
                    background: tier.cta.primary ? c.text : "transparent",
                    color: tier.cta.primary ? c.bg : c.text,
                    border: tier.cta.primary ? "none" : `1px solid ${c.border}`,
                    fontSize: "0.95rem",
                  }}
                >
                  {tier.cta.label}
                </BuyButton>
              ) : tier.cta.href && (tier.cta.href.startsWith("mailto:") || tier.cta.external) ? (
                <a
                  href={tier.cta.href}
                  className="block w-full text-center py-2.5 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
                  style={{
                    background: tier.cta.primary ? c.text : "transparent",
                    color: tier.cta.primary ? c.bg : c.text,
                    border: tier.cta.primary ? "none" : `1px solid ${c.border}`,
                    fontSize: "0.95rem",
                    textDecoration: "none",
                  }}
                >
                  {tier.cta.label}
                </a>
              ) : (
                <Link
                  href={tier.cta.href ?? "#"}
                  className="block w-full text-center py-2.5 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
                  style={{
                    background: tier.cta.primary ? c.text : "transparent",
                    color: tier.cta.primary ? c.bg : c.text,
                    border: tier.cta.primary ? "none" : `1px solid ${c.border}`,
                    fontSize: "0.95rem",
                    textDecoration: "none",
                  }}
                >
                  {tier.cta.label}
                </Link>
              )}
            </motion.div>
          ))}
        </div>

        <motion.p
          className="text-center mt-10"
          style={{
            fontSize: "0.85rem",
            color: c.textMuted,
            maxWidth: 640,
            margin: "2.5rem auto 0",
          }}
          initial={{ opacity: 0 }}
          animate={visible ? { opacity: 1 } : {}}
          transition={{ duration: 0.7, delay: 0.6 }}
        >
          Read the{" "}
          <a
            href="https://github.com/Artexis10/endstate/blob/main/PRINCIPLES.md"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: c.textSec,
              textDecoration: "underline",
              textDecorationColor: "rgba(153,153,153,0.3)",
            }}
          >
            principles
          </a>{" "}
          for what these commitments mean and what they rule out.
        </motion.p>
      </div>
    </section>
  );
}

/* ── Guides ── */
function Guides() {
  const { ref, visible } = useInView();
  const guides = [
    {
      href: "/blog/transfer-programs-to-another-computer",
      label: "How to transfer programs from one computer to another",
    },
    {
      href: "/blog/new-windows-pc-setup-guide",
      label: "The complete guide to setting up a new Windows PC",
    },
    {
      href: "/blog/restore-windows-apps-and-settings-after-reinstall",
      label: "How to restore Windows apps and settings after reinstalling Windows",
    },
    {
      href: "/blog/free-open-source-pc-migration-alternative",
      label: "A free, open-source alternative to EaseUS, Zinstall & Laplink",
    },
    {
      href: "/blog/reinstall-all-apps-with-winget",
      label: "How to reinstall all your apps with winget (and what it misses)",
    },
    {
      href: "/blog/winget-export-microsoft-store-apps",
      label: "Why winget export skips your Microsoft Store apps",
    },
  ];
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
          <SectionLabel>Guides</SectionLabel>
        </motion.div>
        <motion.h2
          className="mb-8"
          style={{
            fontSize: "clamp(1.8rem, 3.5vw, 2.4rem)",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: c.text,
          }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.1 }}
        >
          Setting up a new PC?
        </motion.h2>
        <motion.div
          className="flex flex-col"
          style={{ maxWidth: 720, borderTop: `1px solid #1f1f1f` }}
          initial={{ opacity: 0, y: 8 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          {guides.map((guide) => (
            <a
              key={guide.href}
              href={guide.href}
              className="flex items-center justify-between gap-4 transition-colors duration-200"
              style={{
                padding: "16px 0",
                borderBottom: `1px solid #1f1f1f`,
                fontSize: "0.95rem",
                color: c.text,
                textDecoration: "none",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = c.teal)}
              onMouseLeave={(e) => (e.currentTarget.style.color = c.text)}
            >
              <span>{guide.label}</span>
              <span style={{ color: c.teal, flexShrink: 0 }} aria-hidden="true">
                →
              </span>
            </a>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* ── Closing ── */
function Closing() {
  const { ref, visible } = useInView();
  return (
    <section
      ref={ref}
      className="px-6"
      style={{ background: c.bg, borderTop: `1px solid #1f1f1f`, padding: "96px 24px" }}
    >
      <div className="mx-auto text-center" style={{ maxWidth: 768 }}>
        <motion.p
          className="mb-6"
          style={{
            fontSize: "clamp(1.3rem, 2.5vw, 1.7rem)",
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: c.text,
            lineHeight: 1.4,
          }}
          initial={{ opacity: 0, y: 12 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          Next time you&apos;re staring at a fresh Windows install — this is the first thing to
          install.
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={visible ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.8, ease: "easeOut", delay: 0.1 }}
        >
          <Link
            href="/download"
            className="inline-flex items-center justify-center gap-2 px-7 py-3 rounded-lg font-semibold hover:opacity-88 transition-all duration-200"
            style={{ background: c.text, color: c.bg, fontSize: "1rem", textDecoration: "none" }}
          >
            Download free
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

/* ── Page ── */
export default function EndstatePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <ElevationStyles />
      <main
        style={{
          fontFamily: "var(--font-dm-sans), -apple-system, sans-serif",
          background: c.bg,
          minHeight: "100vh",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        <PaddleTransactionOpener />
        <Nav />
        <Hero />
        <Showcase />
        <HowItWorks />
        <Features />
        <Contrast />
        <FAQ />
        <Pricing />
        <Guides />
        <Closing />
        <EndstateFooter />
      </main>
    </>
  );
}
