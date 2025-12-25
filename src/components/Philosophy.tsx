"use client";

import { useEffect, useRef, useState } from "react";

export default function Philosophy() {
  const axioms = [
    "Systems precede products.",
    "Constraints enable clarity.",
    "Foundations compound.",
    "Simplicity is not reduction.",
  ];

  const sectionRef = useRef<HTMLElement>(null);
  const [visibleIndices, setVisibleIndices] = useState<Set<number>>(new Set());

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    // If reduced motion, show all immediately
    if (prefersReducedMotion) {
      setVisibleIndices(new Set(axioms.map((_, i) => i)));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const index = Number(entry.target.getAttribute("data-index"));
            // Staggered reveal: each axiom appears 280ms after the previous
            // Longer delay creates intentional pacing, not rapid-fire
            setTimeout(() => {
              setVisibleIndices((prev) => new Set([...prev, index]));
            }, index * 280);
          }
        });
      },
      { threshold: 0.3, rootMargin: "-50px" }
    );

    const axiomElements = sectionRef.current?.querySelectorAll("[data-index]");
    axiomElements?.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [axioms.length]);

  return (
    <section ref={sectionRef} className="py-40 sm:py-52 px-6">
      <div className="max-w-3xl mx-auto">
        {/* Increased vertical spacing for breathing room */}
        <div className="space-y-16 sm:space-y-20 md:space-y-24">
          {axioms.map((axiom, index) => (
            <p
              key={index}
              data-index={index}
              className={`text-xl sm:text-2xl md:text-3xl text-neutral-300 font-light tracking-tight
                ${visibleIndices.has(index) ? "animate-axiom" : "opacity-0"}`}
              style={{
                animationFillMode: "forwards",
              }}
            >
              {axiom}
            </p>
          ))}
        </div>
      </div>
    </section>
  );
}
