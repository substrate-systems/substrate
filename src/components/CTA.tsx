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

  // Magnetic effect: restrained 6px max offset
  const handleMouseMove = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (prefersReducedMotion || !buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const distanceX = e.clientX - centerX;
    const distanceY = e.clientY - centerY;

    const maxOffset = 6;
    const x = Math.max(-maxOffset, Math.min(maxOffset, distanceX * 0.06));
    const y = Math.max(-maxOffset, Math.min(maxOffset, distanceY * 0.06));

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
    <section className="py-32 sm:py-40 px-6">
      <div className="max-w-content mx-auto text-center">
        <p className="text-body-lg sm:text-heading-sm text-fg-secondary mb-12">
          Selective early access.
        </p>

        {/* 
          CTA: Magnetic interaction with restrained hover affordance
          - Border brightens on hover
          - Background glow appears
          - Text gains subtle brightness
        */}
        <a
          ref={buttonRef}
          href="mailto:access@substrate.systems"
          onMouseMove={handleMouseMove}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="group relative inline-block px-8 py-4 text-body bg-transparent"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            transition: prefersReducedMotion
              ? "none"
              : "transform 150ms cubic-bezier(0.25, 1, 0.5, 1)",
          }}
        >
          {/* Border: visible affordance, brightens on hover */}
          <span
            className="absolute inset-0 border transition-colors duration-default"
            style={{
              borderColor: isHovered
                ? "var(--border-strong)"
                : "var(--border-default)",
            }}
          />

          {/* Background glow: appears on hover for depth */}
          <span
            className="absolute inset-0 bg-accent-highlight transition-opacity duration-default"
            style={{
              opacity: isHovered ? 1 : 0,
            }}
          />

          {/* Text: subtle brightness increase on hover */}
          <span
            className="relative z-elevated transition-colors duration-default"
            style={{
              color: isHovered
                ? "var(--fg-primary)"
                : "var(--fg-secondary)",
            }}
          >
            Request access
          </span>
        </a>
      </div>
    </section>
  );
}
