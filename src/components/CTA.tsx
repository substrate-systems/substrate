"use client";

import { useRef, useEffect, useState } from "react";
import { motion } from "framer-motion";

export default function CTA() {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <section className="relative w-full py-32 sm:py-40">
      <div className="mx-auto w-full max-w-3xl px-6 text-center">
        <p className="text-lg sm:text-xl font-light text-fg-secondary mb-12">
          Our first product is live.
        </p>

        <a
          href="/endstate"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className="group relative inline-block px-8 py-4 text-body bg-transparent"
        >
          <motion.span
            className="absolute inset-0 border"
            animate={{
              borderColor: isHovered ? "var(--border-strong)" : "var(--border-default)",
            }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          />

          <motion.span
            className="absolute inset-0 bg-accent-highlight"
            animate={{
              opacity: isHovered ? 1 : 0,
            }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          />

          <motion.span
            className="relative z-elevated text-base font-light"
            animate={{
              color: isHovered ? "var(--fg-primary)" : "var(--fg-secondary)",
            }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            See Endstate →
          </motion.span>
        </a>
      </div>
    </section>
  );
}
