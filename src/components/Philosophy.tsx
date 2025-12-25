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
            // Staggered reveal: 300ms between each axiom (matches duration-default)
            setTimeout(() => {
              setVisibleIndices((prev) => new Set([...prev, index]));
            }, index * 300);
          }
        });
      },
      { threshold: 0.3, rootMargin: "-48px" }
    );

    const axiomElements = sectionRef.current?.querySelectorAll("[data-index]");
    axiomElements?.forEach((el) => observer.observe(el));

    return () => observer.disconnect();
  }, [axioms.length]);

  return (
    <section ref={sectionRef} className="py-32 sm:py-40 px-6">
      <div className="max-w-content mx-auto">
        {/* Architectural spacing between axioms */}
        <div className="space-y-16 sm:space-y-24">
          {axioms.map((axiom, index) => (
            <p
              key={index}
              data-index={index}
              className={`text-heading-sm sm:text-heading-lg md:text-display-sm text-fg-secondary
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
