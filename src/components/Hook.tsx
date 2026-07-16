"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

export default function Hook() {
  const sectionRef = useRef<HTMLElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    if (shouldReduceMotion) {
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
  }, [shouldReduceMotion]);

  const shouldAnimate = isVisible && !shouldReduceMotion;

  return (
    <section id="content" ref={sectionRef} className="relative w-full scroll-mt-8 pt-24 pb-0">
      <div className="mx-auto w-full max-w-3xl px-6 text-center">
        <div className="overflow-hidden py-1">
          <motion.div
            initial={false}
            animate={
              shouldAnimate
                ? {
                    opacity: [1, 0.72, 1],
                    y: [0, 20, 0],
                    clipPath: ["inset(0% 0 0 0)", "inset(18% 0 0 0)", "inset(0% 0 0 0)"],
                  }
                : { opacity: 1, y: 0, clipPath: "inset(0% 0 0 0)" }
            }
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { duration: 0.85, times: [0, 0.35, 1], ease: [0.22, 1, 0.36, 1] }
            }
          >
            <p className="text-2xl font-light tracking-tight text-fg-primary sm:text-3xl md:text-4xl">
              Software should leave you with more control, not less.
            </p>
            <p className="mx-auto mt-6 max-w-3xl text-base font-light leading-relaxed text-fg-secondary sm:text-lg">
              Substrate builds systems for continuity—across machines, knowledge, and the memory our
              tools carry forward.
            </p>
          </motion.div>
        </div>

        <div
          data-narrative-connector-base="hook"
          aria-hidden="true"
          className="relative ml-[5px] mt-16 h-24 w-px bg-border-default sm:ml-[7px] sm:h-32"
        >
          <motion.div
            data-narrative-connector-signal="hook"
            className="absolute inset-0 origin-top bg-gradient-to-b from-transparent via-fg-secondary to-transparent motion-reduce:hidden"
            initial={false}
            animate={
              shouldAnimate
                ? { opacity: [0, 1, 0], scaleY: [0.35, 1, 1] }
                : { opacity: 0, scaleY: 1 }
            }
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { duration: 0.9, times: [0, 0.55, 1], ease: [0.22, 1, 0.36, 1] }
            }
          />
        </div>
      </div>
    </section>
  );
}
