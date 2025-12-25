"use client";

import { useRef, useEffect, useState } from "react";

export default function CTA() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
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

  const handleMouseMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (prefersReducedMotion || !buttonRef.current) return;

    const rect = buttonRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const distanceX = e.clientX - centerX;
    const distanceY = e.clientY - centerY;

    const maxOffset = 3;
    const x = Math.max(-maxOffset, Math.min(maxOffset, distanceX * 0.02));
    const y = Math.max(-maxOffset, Math.min(maxOffset, distanceY * 0.02));

    setOffset({ x, y });
  };

  const handleMouseLeave = () => {
    setOffset({ x: 0, y: 0 });
  };

  return (
    <section className="py-32 sm:py-40 px-6">
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-lg sm:text-xl text-neutral-400 font-light mb-12">
          Selective early access.
        </p>

        <button
          ref={buttonRef}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          className="group relative px-8 py-4 text-base font-light text-white border border-neutral-700 hover:border-neutral-500 transition-colors duration-300 bg-transparent"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px)`,
            transition: prefersReducedMotion
              ? "none"
              : "transform 0.15s ease-out, border-color 0.3s ease",
          }}
        >
          <span className="relative z-10">Early access</span>
          <div className="absolute inset-0 bg-white/[0.02] opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
        </button>
      </div>
    </section>
  );
}
