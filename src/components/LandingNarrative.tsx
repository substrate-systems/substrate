import Image from "next/image";
import type { CSSProperties } from "react";
import LandingRevealManager from "./LandingRevealManager";
import LandingSpine from "./LandingSpine";

const principles = [
  "Your AI should show its sources.",
  "Your setup should survive the machine.",
  "Your memory should outlive the session.",
] as const;

const products = [
  {
    id: "q",
    name: "Q",
    principle: principles[0],
    description:
      "Source-grounded AI for content libraries. Turn original material into a branded knowledge system with answers that cite their sources.",
    href: "https://useq.ai",
    external: true,
  },
  {
    id: "endstate",
    name: "Endstate",
    principle: principles[1],
    description:
      "Local-first Windows setup and restore. Capture your apps and settings once, then rebuild a fresh machine in minutes.",
    href: "/endstate",
    external: false,
  },
  {
    id: "exomem",
    name: "Exomem",
    principle: principles[2],
    description:
      "Durable memory for AI agents, built on Markdown you own. Carry context across sessions without surrendering the source.",
    href: "/exomem",
    external: false,
  },
] as const;

export default function LandingNarrative() {
  return (
    <section className="landing-below-fold relative overflow-hidden bg-[#050505]">
      <div className="landing-afterglow" aria-hidden="true">
        <Image
          src="/brand/materials/aurora-afterglow.jpg"
          alt=""
          fill
          loading="lazy"
          decoding="async"
          sizes="100vw"
          className="object-cover object-[44%_46%]"
        />
      </div>
      <div className="noise-overlay" aria-hidden="true" />

      <div
        className="landing-editorial relative mx-auto w-full max-w-[880px] px-6"
        style={
          {
            "--sx": "clamp(6px, 3vw, 20px)",
            "--pad": "clamp(44px, 8vw, 92px)",
          } as CSSProperties
        }
      >
        <div data-spine-zone className="relative">
          <div data-spine-static aria-hidden="true" />
          <LandingSpine />

          <div
            id="content"
            data-thesis
            className="scroll-mt-6 pt-[clamp(110px,16vh,170px)]"
            style={{ marginLeft: "var(--pad)" }}
          >
            <p
              data-reveal
              className="m-0 max-w-[800px] text-balance text-[clamp(30px,4.4vw,56px)] font-light leading-[1.14] tracking-[-0.025em] text-[#fafafa]"
            >
              Software should leave you with more control, not less.
            </p>
            <p
              data-reveal
              data-reveal-delay="140"
              className="mt-7 max-w-[560px] text-pretty text-[clamp(16px,1.35vw,19px)] font-light leading-[1.7] text-[#a3a3a3]"
            >
              Substrate builds systems for continuity—across machines, knowledge, and the memory our
              tools carry forward.
            </p>
          </div>

          <ol
            data-principles
            className="m-0 flex list-none flex-col gap-[clamp(84px,13vh,140px)] py-[clamp(100px,15vh,170px)] pb-[clamp(90px,13vh,150px)]"
            style={{ marginLeft: "var(--pad)" }}
          >
            {principles.map((principle, index) => (
              <li key={principle} className="relative">
                <span
                  data-spine-node={index}
                  data-active="false"
                  aria-hidden="true"
                  className="landing-spine-node"
                />
                <span aria-hidden="true" className="landing-spine-connector" />
                <div data-reveal>
                  <span className="mb-4 block text-xs uppercase tracking-[0.2em] text-[#7a7a7a]">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <p className="m-0 max-w-[680px] text-balance text-[clamp(26px,3.4vw,42px)] font-light leading-[1.22] tracking-[-0.02em] text-[#fafafa]">
                    {principle}
                  </p>
                </div>
              </li>
            ))}
          </ol>

          <h2
            data-reveal
            className="mb-[22px] pl-[var(--pad)] text-xs font-normal uppercase tracking-[0.2em] text-[#7a7a7a]"
          >
            Products
          </h2>
        </div>

        <div data-products style={{ marginLeft: "var(--sx)" }}>
          {products.map((product, index) => (
            <a
              key={product.id}
              data-product-row={product.id}
              data-reveal
              data-reveal-delay={index * 100}
              href={product.href}
              target={product.external ? "_blank" : undefined}
              rel={product.external ? "noopener noreferrer" : undefined}
              className="landing-product-row block border-t border-white/[0.08] py-[clamp(36px,5vh,52px)] pr-4 pl-[calc(var(--pad)-var(--sx))] text-[#a3a3a3] last:border-b focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#a3a3a3]"
            >
              <span className="mb-[18px] block text-[13px] font-light text-[#7a7a7a]">
                {String(index + 1).padStart(2, "0")} · {product.principle}
              </span>
              <span className="flex flex-wrap items-baseline justify-between gap-4">
                <span className="text-[clamp(30px,3.8vw,46px)] font-light leading-[1.1] tracking-[-0.02em] text-[#fafafa]">
                  {product.name}
                </span>
                <span className="text-sm font-light text-[#7a7a7a]">
                  Learn more {product.external ? "↗" : "→"}
                </span>
              </span>
              <span className="mt-3.5 block max-w-[600px] text-pretty text-[clamp(16px,1.3vw,19px)] font-light leading-[1.65] text-[#a3a3a3]">
                {product.description}
              </span>
            </a>
          ))}
        </div>

        <p
          data-closing-axiom
          data-reveal
          className="mt-[clamp(110px,15vh,160px)] px-6 text-center text-[clamp(22px,2.4vw,30px)] font-light tracking-[-0.02em] text-[#fafafa]"
        >
          Systems precede products.
        </p>
      </div>
      <LandingRevealManager />
    </section>
  );
}
