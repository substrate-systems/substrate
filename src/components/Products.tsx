"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

const products = [
  {
    name: "Q",
    description:
      "Source-grounded AI for content libraries. Turn original material into a branded knowledge system with answers that cite their sources.",
    href: "https://useq.ai",
    external: true,
  },
  {
    name: "Endstate",
    description:
      "Local-first Windows setup and restore. Capture your apps and settings once, then rebuild a fresh machine in minutes.",
    href: "/endstate",
    external: false,
  },
  {
    name: "Exomem",
    description:
      "Durable memory for AI agents, built on Markdown you own. Carry context across sessions without surrendering the source.",
    href: "/exomem",
    external: false,
  },
];

export default function Products() {
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
      { threshold: 0.2, rootMargin: "-48px" }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, [shouldReduceMotion]);

  const shouldAnimate = isVisible && !shouldReduceMotion;
  return (
    <section
      ref={sectionRef}
      className="relative w-full py-32 sm:py-40 border-t border-border-subtle"
    >
      <div className="mx-auto w-full max-w-3xl px-6">
        <motion.div
          className="mb-16"
          initial={false}
          animate={shouldAnimate ? { opacity: [1, 0.78, 1], y: [0, 8, 0] } : { opacity: 1, y: 0 }}
          transition={
            shouldReduceMotion
              ? { duration: 0 }
              : { duration: 0.8, times: [0, 0.35, 1], ease: "easeOut" }
          }
        >
          <h2 className="text-xs uppercase tracking-[0.2em] text-fg-tertiary">Products</h2>
        </motion.div>

        <div className="space-y-16">
          {products.map((product, index) => {
            const headingDelay = 0.1 + index * 0.15;
            const descDelay = 0.2 + index * 0.15;
            const arrowDelay = 0.3 + index * 0.15;
            const linkLabel = product.external ? "Learn more ↗" : "Learn more →";

            const anchorProps = product.external
              ? {
                  href: product.href,
                  target: "_blank",
                  rel: "noopener noreferrer",
                }
              : { href: product.href };

            return (
              <a
                key={product.name}
                {...anchorProps}
                className="group relative block space-y-4 rounded-sm py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-strong"
              >
                <span
                  aria-hidden="true"
                  className="absolute -top-4 left-0 h-px w-full origin-left scale-x-0 bg-border-default transition-transform duration-default group-hover:scale-x-100 group-focus-visible:scale-x-100 motion-reduce:transition-none"
                />
                <div className="flex items-baseline justify-between gap-4 flex-wrap">
                  <motion.h3
                    className="text-2xl sm:text-3xl md:text-4xl font-light tracking-tight text-fg-primary group-hover:text-white group-focus-visible:text-white transition-colors duration-300 motion-reduce:transition-none"
                    initial={false}
                    animate={
                      shouldAnimate
                        ? { opacity: [1, 0.78, 1], y: [0, 10, 0] }
                        : { opacity: 1, y: 0 }
                    }
                    transition={
                      shouldReduceMotion
                        ? { duration: 0 }
                        : {
                            duration: 0.9,
                            times: [0, 0.35, 1],
                            ease: "easeOut",
                            delay: headingDelay,
                          }
                    }
                  >
                    {product.name}
                  </motion.h3>
                  <motion.span
                    className="text-sm font-light text-fg-tertiary transition duration-300 group-hover:translate-x-1 group-hover:text-fg-secondary group-focus-visible:translate-x-1 group-focus-visible:text-fg-secondary motion-reduce:transform-none motion-reduce:transition-none"
                    initial={false}
                    animate={shouldAnimate ? { opacity: [1, 0.72, 1] } : { opacity: 1 }}
                    transition={
                      shouldReduceMotion
                        ? { duration: 0 }
                        : {
                            duration: 0.7,
                            times: [0, 0.35, 1],
                            ease: "easeOut",
                            delay: arrowDelay,
                          }
                    }
                  >
                    {linkLabel}
                  </motion.span>
                </div>
                <motion.p
                  className="text-lg sm:text-xl font-light text-fg-secondary max-w-xl"
                  initial={false}
                  animate={
                    shouldAnimate ? { opacity: [1, 0.78, 1], y: [0, 8, 0] } : { opacity: 1, y: 0 }
                  }
                  transition={
                    shouldReduceMotion
                      ? { duration: 0 }
                      : {
                          duration: 0.8,
                          times: [0, 0.35, 1],
                          ease: "easeOut",
                          delay: descDelay,
                        }
                  }
                >
                  {product.description}
                </motion.p>
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}
