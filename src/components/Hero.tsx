"use client";

import { useEffect, useRef } from "react";

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
      const x = (clientX / innerWidth - 0.5) * 8;
      const y = (clientY / innerHeight - 0.5) * 8;
      backgroundRef.current.style.transform = `translate(${x}px, ${y}px)`;
    };

    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <div
        ref={backgroundRef}
        className="absolute inset-0 transition-transform duration-700 ease-out"
        style={{ willChange: "transform" }}
      >
        <div className="absolute inset-0 bg-gradient-to-b from-neutral-950 via-neutral-900/50 to-neutral-950" />
        <div className="absolute inset-0 opacity-[0.03]">
          <svg
            className="w-full h-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <defs>
              <pattern
                id="grid"
                width="10"
                height="10"
                patternUnits="userSpaceOnUse"
              >
                <path
                  d="M 10 0 L 0 0 0 10"
                  fill="none"
                  stroke="white"
                  strokeWidth="0.5"
                />
              </pattern>
            </defs>
            <rect width="100" height="100" fill="url(#grid)" />
          </svg>
        </div>
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-white/[0.02] rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-64 h-64 bg-white/[0.015] rounded-full blur-2xl" />
      </div>

      <div className="relative z-10 text-center px-6 animate-fade-in">
        <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-light tracking-tight text-white mb-8">
          Substrate
        </h1>
        <p className="text-lg sm:text-xl md:text-2xl text-neutral-400 font-light max-w-2xl mx-auto leading-relaxed">
          A foundational systems company.
        </p>
        <p className="text-base sm:text-lg text-neutral-500 font-light mt-4 max-w-xl mx-auto">
          Building infrastructure for what comes next.
        </p>
      </div>

      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 animate-fade-in-delayed">
        <div className="w-px h-16 bg-gradient-to-b from-transparent via-neutral-600 to-transparent" />
      </div>
    </section>
  );
}
