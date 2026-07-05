"use client";

import { useEffect } from "react";

/**
 * Substrate scroll-reveal grammar for the Exomem page: every `[data-reveal]`
 * element fades up 14px → 0 over 0.9s (out-expo) as it enters the viewport,
 * with an optional per-element `data-reveal-delay` (ms) for sibling staggers.
 *
 * Mounted once near the page root. Elements stay server-rendered and visible in
 * the no-JS / reduced-motion case — we only hide-then-reveal when motion is
 * allowed, matching the design handoff.
 */
export default function RevealManager() {
  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) return;

    const els = Array.from(
      document.querySelectorAll<HTMLElement>("[data-reveal]"),
    );
    els.forEach((el) => {
      el.style.opacity = "0";
      el.style.transform = "translateY(14px)";
      el.style.willChange = "opacity, transform";
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target as HTMLElement;
          const delay = Number(el.getAttribute("data-reveal-delay") || 0);
          el.style.transition =
            `opacity 0.9s cubic-bezier(0.16,1,0.3,1) ${delay}ms,` +
            ` transform 0.9s cubic-bezier(0.16,1,0.3,1) ${delay}ms`;
          el.style.opacity = "1";
          el.style.transform = "none";
          io.unobserve(el);
        });
      },
      { threshold: 0.2, rootMargin: "-48px 0px" },
    );

    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return null;
}
