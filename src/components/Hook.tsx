"use client";

import { useEffect, useRef, useState } from "react";

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
        <p
          className={`text-lg sm:text-xl font-light text-fg-secondary
            ${isVisible ? "animate-axiom" : "opacity-0"}`}
          style={{
            animationFillMode: "forwards",
          }}
        >
          Infrastructure that compounds.
        </p>
        <div
          className={`mt-6 mx-auto w-16 h-px bg-gradient-to-r from-transparent via-border-default to-transparent
            ${isVisible ? "animate-axiom" : "opacity-0"}`}
          style={{
            animationFillMode: "forwards",
            animationDelay: "200ms",
          }}
        />
      </div>
    </section>
  );
}
