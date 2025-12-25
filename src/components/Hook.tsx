"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";

export default function Hook() {
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
      { threshold: 0.3, rootMargin: "-48px" }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (
    <section ref={sectionRef} className="relative w-full py-24">
      <div className="mx-auto w-full max-w-3xl px-6 text-center">
        <motion.p
          className="text-lg sm:text-xl font-light text-fg-secondary"
          initial={{ opacity: 0, y: 8 }}
          animate={isVisible ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          Infrastructure that compounds.
        </motion.p>
        <motion.div
          className="mt-6 mx-auto w-16 h-px bg-gradient-to-r from-transparent via-border-default to-transparent"
          initial={{ opacity: 0 }}
          animate={isVisible ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
        />
      </div>
    </section>
  );
}
