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
  const [parallaxEnabled, setParallaxEnabled] = useState(false);

  useEffect(() => {
    if (shouldReduceMotion) return;

    // Gate parallax to fine-pointer devices only (desktop/mouse)
    const finePointerQuery = window.matchMedia("(pointer: fine)");
    setParallaxEnabled(finePointerQuery.matches);

    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setParallaxEnabled(e.matches);
    };

    // Safari fallback: addListener vs addEventListener
    if (finePointerQuery.addEventListener) {
      finePointerQuery.addEventListener("change", handleChange);
    } else {
      finePointerQuery.addListener(handleChange);
    }

    return () => {
      if (finePointerQuery.removeEventListener) {
        finePointerQuery.removeEventListener("change", handleChange);
      } else {
        finePointerQuery.removeListener(handleChange);
      }
    };
  }, [shouldReduceMotion]);

  useEffect(() => {
    if (shouldReduceMotion || !parallaxEnabled) return;

    const MAX = 8;

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
  }, [shouldReduceMotion, parallaxEnabled, mouseX, mouseY]);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <section className="relative min-h-[100svh] sm:min-h-screen sm:min-h-[100dvh] flex items-center justify-center overflow-hidden bg-bg-base">
      {/* Authored photographic atmosphere, tuned separately for mobile and desktop crops. */}
      <motion.div
        className="absolute -inset-3 will-change-transform"
        style={{
          x: !mounted || shouldReduceMotion || !parallaxEnabled ? 0 : springX,
          y: !mounted || shouldReduceMotion || !parallaxEnabled ? 0 : springY,
        }}
        aria-hidden="true"
      >
        <picture>
          <source media="(max-width: 639px)" srcSet="/brand/materials/aurora-hero-mobile.jpg" />
          <source
            media="(min-width: 640px) and (max-width: 1023px) and (orientation: portrait)"
            srcSet="/brand/materials/aurora-hero-tablet.jpg"
          />
          {/* A picture element prevents the off-breakpoint crop from being fetched. */}
          <img
            src="/brand/materials/aurora-hero-desktop.jpg"
            alt=""
            fetchPriority="high"
            decoding="sync"
            className="absolute inset-0 h-full w-full object-cover object-[42%_48%] sm:object-[44%_50%] lg:object-[50%_50%]"
          />
        </picture>

        {/* A dark center holds the identity; the brighter outer motion remains visible. */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 68% 52% at 50% 48%, rgba(5,5,5,0.58) 0%, rgba(5,5,5,0.36) 48%, rgba(5,5,5,0.18) 72%, rgba(5,5,5,0.48) 100%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(5,5,5,0.34) 0%, rgba(5,5,5,0.06) 38%, rgba(5,5,5,0.16) 66%, rgba(5,5,5,0.74) 100%)",
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
          Owned machines. Durable memory. Source-grounded AI.
        </p>
      </div>

      {/* Explicit affordance: the homepage continues below the full-height image. */}
      <a
        href="#content"
        className="absolute bottom-5 left-1/2 z-elevated inline-flex min-h-11 min-w-11 -translate-x-1/2 animate-scroll-indicator items-center justify-center gap-2 rounded-full px-4 text-xs font-light uppercase tracking-[0.18em] text-fg-secondary transition-colors duration-default hover:text-fg-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-emphasis sm:bottom-8"
      >
        <span>Explore</span>
        <span aria-hidden="true">↓</span>
      </a>

      <a
        href="/photography"
        className="animate-photo-credit absolute right-5 bottom-10 z-elevated hidden text-[11px] font-light uppercase tracking-[0.14em] text-[#a3a3a3] transition-colors duration-default hover:text-[#fafafa] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#a3a3a3] sm:block"
      >
        Iceland · March 2026
      </a>

      <div
        aria-hidden="true"
        className="landing-hero-dissolve pointer-events-none absolute right-0 bottom-0 left-0 z-[5] h-[20vh]"
      />
    </section>
  );
}
