"use client";

import { useEffect } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

export default function LandingRevealManager() {
  useEffect(() => {
    const motionQuery = window.matchMedia(REDUCED_QUERY);
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    let observer: IntersectionObserver | undefined;

    const show = (target: HTMLElement, animate: boolean) => {
      const delay = Number(target.dataset.revealDelay ?? 0);
      target.style.transition = animate
        ? `opacity 0.9s cubic-bezier(0.16,1,0.3,1) ${delay}ms, transform 0.9s cubic-bezier(0.16,1,0.3,1) ${delay}ms`
        : "";
      target.style.opacity = "";
      target.style.transform = "";
      delete target.dataset.revealState;
    };

    const reset = () => {
      observer?.disconnect();
      observer = undefined;
      targets.forEach((target) => show(target, false));
    };

    const setup = () => {
      reset();
      if (motionQuery.matches) return;

      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            const target = entry.target as HTMLElement;
            show(target, true);
            observer?.unobserve(target);
          });
        },
        { threshold: 0.2, rootMargin: "-32px" }
      );

      targets.forEach((target) => {
        if (target.getBoundingClientRect().top <= window.innerHeight * 0.92) return;
        target.dataset.revealState = "hidden";
        target.style.opacity = "0";
        target.style.transform = "translateY(14px)";
        observer?.observe(target);
      });
    };

    motionQuery.addEventListener("change", setup);
    setup();
    return () => {
      reset();
      motionQuery.removeEventListener("change", setup);
    };
  }, []);

  return null;
}
