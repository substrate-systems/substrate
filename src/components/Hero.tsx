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
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden bg-bg-base">
      {/* Material background: explicitly mounted with Image component */}
      <div
        ref={backgroundRef}
        className="absolute inset-0 animate-hero-background"
        style={{ willChange: "transform" }}
        aria-hidden="true"
      >
        {/* Material image: directly rendered for visibility */}
        <Image
          src="/brand/materials/metal-structure-dark.jpg"
          alt=""
          fill
          className="object-cover opacity-[0.12]"
          priority
        />
        {/* Vignette overlay: grounds the material to edges */}
        <div 
          className="absolute inset-0" 
          style={{ 
            background: 'radial-gradient(ellipse 80% 60% at 50% 40%, transparent 0%, #050505 70%)' 
          }} 
        />
        {/* Bottom fade: ensures content readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-bg-base via-transparent to-transparent" />
      </div>

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
            priority
          />
        </div>
        
        {/* Primary tagline: medium motion (24px), clear size jump from secondary */}
        <h1 className="animate-hero-tagline text-xl sm:text-2xl md:text-[2rem] font-light tracking-tight text-fg-primary max-w-content mx-auto leading-tight">
          A foundational systems company.
        </h1>
        
        {/* Secondary tagline: smallest motion (16px), clearly subordinate */}
        <p className="animate-hero-secondary text-base sm:text-lg font-light text-fg-secondary mt-4 max-w-content mx-auto">
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
