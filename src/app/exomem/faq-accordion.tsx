"use client";

import { useState } from "react";

const MONO = "var(--font-mono-exo)";
const OUT_EXPO = "cubic-bezier(0.16,1,0.3,1)";
const STD_EASE = "cubic-bezier(0.33,1,0.68,1)";

export type ExoFaq = { q: string; a: string };

/**
 * FAQ accordion — one row open at a time. Answer collapses via max-height
 * (0 ↔ 520px) + opacity; the `+` glyph rotates 45° and turns amber when open.
 */
export default function FaqAccordion({ items }: { items: ExoFaq[] }) {
  const [open, setOpen] = useState(-1);

  return (
    <div
      data-reveal
      data-reveal-delay="160"
      style={{
        marginTop: "36px",
        borderTop: "1px solid var(--exo-border-card)",
      }}
    >
      {items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div
            key={item.q}
            style={{ borderBottom: "1px solid var(--exo-border-card)" }}
          >
            <button
              type="button"
              onClick={() => setOpen(isOpen ? -1 : i)}
              aria-expanded={isOpen}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: "16px",
                background: "none",
                border: "none",
                padding: "20px 0",
                cursor: "pointer",
                textAlign: "left",
                transition: `opacity 200ms ${STD_EASE}`,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.8")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: "15px",
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                  lineHeight: 1.45,
                  color: "var(--fg-primary)",
                }}
              >
                {item.q}
              </span>
              <span
                aria-hidden="true"
                style={{
                  flex: "none",
                  fontFamily: MONO,
                  fontSize: "18px",
                  fontWeight: 400,
                  lineHeight: 1,
                  color: isOpen ? "var(--exo-amber)" : "var(--fg-tertiary)",
                  transform: isOpen ? "rotate(45deg)" : "none",
                  transition: `transform 300ms ${OUT_EXPO}, color 300ms ${STD_EASE}`,
                }}
              >
                +
              </span>
            </button>
            <div
              style={{
                overflow: "hidden",
                maxHeight: isOpen ? "520px" : "0px",
                opacity: isOpen ? 1 : 0,
                transition: `max-height 450ms ${OUT_EXPO}, opacity 350ms ${STD_EASE}`,
              }}
            >
              <p
                style={{
                  margin: 0,
                  padding: "0 32px 22px 0",
                  fontSize: "0.95rem",
                  fontWeight: 300,
                  lineHeight: 1.7,
                  color: "var(--fg-secondary)",
                }}
              >
                {item.a}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
