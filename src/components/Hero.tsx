"use client";

import { motion, useMotionValue, useSpring, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";
import Image from "next/image";

export default function Hero() {
  const shouldReduceMotion = useReducedMotion();

  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);

  const springX = useSpring(mouseX, { stiffness: 150, damping: 30 });
  const springY = useSpring(mouseY, { stiffness: 150, damping: 30 });

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (shouldReduceMotion) return;

    const MAX = 12;

    const handlePointerMove = (e: PointerEvent) => {
      const { clientX, clientY } = e;
      const { innerWidth, innerHeight } = window;
      const x = (clientX / innerWidth - 0.5) * MAX;
      const y = (clientY / innerHeight - 0.5) * MAX;
      mouseX.set(x);
      mouseY.set(y);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [shouldReduceMotion, mouseX, mouseY]);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <section className="relative min-h-screen min-h-[100dvh] flex items-center justify-center overflow-hidden bg-bg-base">
      {/* Material background: explicitly mounted with Image component */}
      {/* LCP optimization: initial={{ x: 0, y: 0 }} ensures immediate paint at final position */}
      <motion.div
        className="absolute -inset-px"
        style={{
          x: !mounted || shouldReduceMotion ? 0 : springX,
          y: !mounted || shouldReduceMotion ? 0 : springY,
        }}
        aria-hidden="true"
      >
        {/* Material image: directly rendered for visibility */}
        {/* LCP optimization: removed filter to eliminate composite layer delay */}
        <Image
          src="/brand/materials/metal-structure-dark.jpg"
          alt=""
          fill
          sizes="100vw"
          className="object-cover opacity-[0.30] sm:opacity-[0.22]"
          priority
          fetchPriority="high"
        />
        {/* Mobile vignette: taller ellipse prevents bottom cutoff */}
        <div
          className="absolute inset-0 opacity-15 sm:hidden"
          style={{
            background:
              "radial-gradient(ellipse 140% 130% at 50% 45%, rgba(5,5,5,0) 0%, rgba(5,5,5,0.65) 100%)",
          }}
        />

        {/* Desktop vignette: tighter ellipse for premium edge darkening */}
        <div
          className="absolute inset-0 hidden sm:block opacity-30"
          style={{
            background:
              "radial-gradient(ellipse 85% 70% at 50% 45%, transparent 0%, rgba(5,5,5,0.5) 80%)",
          }}
        />
      </motion.div>

      {/* Noise overlay: dithers gradients, eliminates banding */}
      <div className="noise-overlay" aria-hidden="true" />

      {/* Content layer: clear hierarchy, physical motion */}
      <div className="relative z-elevated text-center px-6">
        {/* Wordmark: largest motion (32px), primary focal point */}
        <div className="animate-hero-wordmark mb-6">
          <Image
            src="/brand/logos/substrate-logo-white-transparent.png"
            alt="Substrate"
            width={320}
            height={64}
            className="mx-auto h-10 sm:h-14 md:h-[72px] w-auto"
          />
        </div>

        {/* Primary tagline: medium motion (24px), clear size jump from secondary */}
        <h1 className="animate-hero-tagline text-xl sm:text-2xl md:text-[2rem] font-light tracking-tight text-fg-primary max-w-shell-sm mx-auto leading-tight">
          A foundational systems company.
        </h1>

        {/* Secondary tagline: smallest motion (16px), clearly subordinate */}
        <p className="animate-hero-secondary text-base sm:text-lg font-light text-fg-secondary mt-4 max-w-shell-sm mx-auto">
          Software infrastructure for durable systems.
        </p>
      </div>

      {/* Scroll indicator: appears last, after content has settled */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 animate-scroll-indicator">
        <div className="w-px h-16 bg-gradient-to-b from-transparent via-fg-tertiary to-transparent" />
      </div>
    </section>
  );
}
