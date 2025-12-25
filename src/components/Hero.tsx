"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";

export default function Hero() {
  const backgroundRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    if (prefersReducedMotion) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!backgroundRef.current) return;
      const { clientX, clientY } = e;
      const { innerWidth, innerHeight } = window;
      // Subtle parallax: 8px max offset, restrained but perceptible
      const x = (clientX / innerWidth - 0.5) * 8;
      const y = (clientY / innerHeight - 0.5) * 8;
      backgroundRef.current.style.transform = `translate(${x}px, ${y}px)`;
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Material layer: subtle metallic texture, masked with vignette */}
      <div
        className="material-overlay material-breathe bg-material-structure"
        aria-hidden="true"
      />

      {/* Background layer: grid emerges first to establish spatial context */}
      <div
        ref={backgroundRef}
        className="absolute inset-0 transition-transform duration-emphasis ease-out-expo animate-hero-grid"
        style={{ willChange: "transform" }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-bg-base via-bg-surface/60 to-bg-base" />
        <div className="absolute inset-0 opacity-4">
          <svg
            className="w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <pattern
                id="grid"
                width="8"
                height="8"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 8 0 L 0 0 0 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="0.3"
                  className="text-fg-primary"
                />
              </pattern>
            </defs>
            <rect width="100" height="100" fill="url(#grid)" />
          </svg>
        </div>
        {/* Ambient glow: subtle depth cues */}
        <div className="absolute top-1/4 left-1/4 w-24 h-24 sm:w-32 sm:h-32 md:w-40 md:h-40 bg-accent-glow rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-16 h-16 sm:w-24 sm:h-24 md:w-32 md:h-32 bg-accent-glow rounded-full blur-2xl" />
      </div>

      {/* Content layer: wordmark → tagline → secondary, each with increasing delay */}
      <div className="relative z-elevated text-center px-6">
        {/* Wordmark: primary focal point, enters with blur-to-sharp + rise */}
        <div className="animate-hero-wordmark mb-8">
          <Image
            src="/brand/logos/substrate-logo-white-transparent.png"
            alt="Substrate"
            width={280}
            height={56}
            className="mx-auto h-12 sm:h-12 md:h-16 w-auto"
            priority
          />
        </div>
        
        {/* Primary tagline: follows wordmark */}
        <p className="animate-hero-tagline text-body-lg sm:text-heading-sm md:text-heading-lg text-fg-secondary max-w-content mx-auto">
          A foundational systems company.
        </p>
        
        {/* Secondary tagline: completes the entrance sequence */}
        <p className="animate-hero-secondary text-body sm:text-body-lg text-fg-tertiary mt-4 max-w-content mx-auto">
          Building infrastructure for what comes next.
        </p>
      </div>

      {/* Scroll indicator: appears last, after content has settled */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 animate-scroll-indicator">
        <div className="w-px h-16 bg-gradient-to-b from-transparent via-fg-tertiary to-transparent" />
      </div>
    </section>
  );
}
