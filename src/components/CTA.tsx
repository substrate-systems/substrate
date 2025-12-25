"use client";

import { useRef, useEffect, useState } from "react";

export default function CTA() {
  const buttonRef = useRef<HTMLAnchorElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(true);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    setPrefersReducedMotion(mediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setPrefersReducedMotion(e.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  // Magnetic effect: button follows cursor within proximity
  // Stronger multiplier (0.08) and larger max offset (8px) for noticeable pull
  const handleMouseMove = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (prefersReducedMotion || !buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const distanceX = e.clientX - centerX;
    const distanceY = e.clientY - centerY;

    // Increased magnetic pull: 8px max offset, 0.08 multiplier
    const maxOffset = 8;
    const x = Math.max(-maxOffset, Math.min(maxOffset, distanceX * 0.08));
    const y = Math.max(-maxOffset, Math.min(maxOffset, distanceY * 0.08));

    setOffset({ x, y });
  };

  const handleMouseEnter = () => {
    setIsHovered(true);
  };

  const handleMouseLeave = () => {
    setOffset({ x: 0, y: 0 });
    setIsHovered(false);
  };

  return (
    <section className="py-40 sm:py-52 px-6">
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-lg sm:text-xl text-neutral-400 font-light mb-14">
          Selective early access.
        </p>

        {/* 
          CTA: Magnetic interaction with stronger hover affordance
          - Border brightens significantly on hover
          - Background glow appears
          - Text gains subtle brightness
        */}
        <a
          ref={buttonRef}
          href="mailto:access@substrate.systems"
          onMouseMove={handleMouseMove}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="group relative inline-block px-10 py-5 text-base font-light bg-transparent"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            transition: prefersReducedMotion
              ? "none"
              : "transform 0.2s cubic-bezier(0.25, 1, 0.5, 1)",
          }}
        >
          {/* Border: visible affordance, brightens on hover */}
          <span
            className="absolute inset-0 border transition-colors duration-300"
            style={{
              borderColor: isHovered
                ? "rgba(255, 255, 255, 0.4)"
                : "rgba(255, 255, 255, 0.15)",
            }}
          />

          {/* Background glow: appears on hover for depth */}
          <span
            className="absolute inset-0 transition-opacity duration-300"
            style={{
              background:
                "radial-gradient(ellipse at center, rgba(255,255,255,0.04) 0%, transparent 70%)",
              opacity: isHovered ? 1 : 0,
            }}
          />

          {/* Text: subtle brightness increase on hover */}
          <span
            className="relative z-10 transition-colors duration-300"
            style={{
              color: isHovered
                ? "rgba(255, 255, 255, 1)"
                : "rgba(255, 255, 255, 0.85)",
            }}
          >
            Request access
          </span>
        </a>
      </div>
    </section>
  );
}
