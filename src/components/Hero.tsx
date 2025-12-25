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
      // Subtle parallax: grid shifts opposite to cursor, creating depth
      const x = (clientX / innerWidth - 0.5) * 12;
      const y = (clientY / innerHeight - 0.5) * 12;
      backgroundRef.current.style.transform = `translate(${x}px, ${y}px)`;
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      {/* Background layer: grid emerges first to establish spatial context */}
      <div
        ref={backgroundRef}
        className="absolute inset-0 transition-transform duration-700 ease-out animate-hero-grid"
        style={{ willChange: "transform" }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-neutral-950 via-neutral-900/50 to-neutral-950" />
        <div className="absolute inset-0 opacity-[0.04]">
          <svg
            className="w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
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
                  stroke="white"
                  strokeWidth="0.3"
                />
              </pattern>
            </defs>
            <rect width="100" height="100" fill="url(#grid)" />
          </svg>
        </div>
        {/* Ambient glow: subtle depth cues */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-white/[0.02] rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-white/[0.015] rounded-full blur-2xl" />
      </div>

      {/* Content layer: wordmark → tagline → secondary, each with increasing delay */}
      <div className="relative z-10 text-center px-6">
        {/* Wordmark: primary focal point, enters with blur-to-sharp + rise */}
        <div className="animate-hero-wordmark mb-10">
          <Image
            src="/brand/logos/substrate-logo-white-transparent.png"
            alt="Substrate"
            width={280}
            height={56}
            className="mx-auto h-12 sm:h-14 md:h-16 w-auto"
            priority
          />
        </div>
        
        {/* Primary tagline: follows wordmark */}
        <p className="animate-hero-tagline text-lg sm:text-xl md:text-2xl text-neutral-400 font-light max-w-2xl mx-auto leading-relaxed">
          A foundational systems company.
        </p>
        
        {/* Secondary tagline: completes the entrance sequence */}
        <p className="animate-hero-secondary text-base sm:text-lg text-neutral-500 font-light mt-5 max-w-xl mx-auto">
          Building infrastructure for what comes next.
        </p>
      </div>

      {/* Scroll indicator: appears last, after content has settled */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 animate-scroll-indicator">
        <div className="w-px h-16 bg-gradient-to-b from-transparent via-neutral-600 to-transparent" />
      </div>
    </section>
  );
}
