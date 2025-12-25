"use client";

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

export default function Products() {
  const sectionRef = useRef<HTMLElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    if (prefersReducedMotion) {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
          }
        });
      },
      { threshold: 0.2, rootMargin: "-48px" }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, []);
  return (
    <section ref={sectionRef} className="relative w-full py-32 sm:py-40 border-t border-border-subtle">
      <div className="mx-auto w-full max-w-3xl px-6">
        <motion.div
          className="mb-16"
          initial={{ opacity: 0, y: 8 }}
          animate={isVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          <span className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">
            Products
          </span>
        </motion.div>

        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <motion.h3
              className="text-2xl sm:text-3xl md:text-4xl font-light tracking-tight text-fg-primary"
              initial={{ opacity: 0, y: 10 }}
              animate={isVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
              transition={{ duration: 0.9, ease: "easeOut", delay: 0.1 }}
            >
              Endstate
            </motion.h3>
            <motion.span
              className="text-sm font-light text-fg-tertiary"
              initial={{ opacity: 0 }}
              animate={isVisible ? { opacity: 1 } : { opacity: 0 }}
              transition={{ duration: 0.7, ease: "easeOut", delay: 0.3 }}
            >
              Coming soon
            </motion.span>
          </div>
          <motion.p
            className="text-lg sm:text-xl font-light text-fg-secondary max-w-xl"
            initial={{ opacity: 0, y: 8 }}
            animate={isVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: 0.8, ease: "easeOut", delay: 0.2 }}
          >
            Deterministic state management for complex systems.
          </motion.p>
        </div>
      </div>
    </section>
  );
}
