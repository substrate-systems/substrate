"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

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
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    <section ref={sectionRef} className="relative w-full py-32 sm:py-40">
      <div className="mx-auto w-full max-w-3xl px-6">
        {/* Architectural spacing between axioms */}
        <div className="space-y-12 sm:space-y-16">
          {axioms.map((axiom, index) => (
            <motion.p
              key={index}
              data-index={index}
              className="text-xl sm:text-2xl md:text-3xl font-light tracking-tight text-fg-secondary"
              initial={{ opacity: 0, y: 12 }}
              animate={visibleIndices.has(index) ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
              transition={{
                duration: 0.9,
                ease: "easeOut",
                delay: 0,
              }}
            >
              {axiom}
            </motion.p>
          ))}
        </div>
      </div>
    </section>
  );
}
