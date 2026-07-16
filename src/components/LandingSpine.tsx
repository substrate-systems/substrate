"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const subscribeToHydration = () => () => undefined;
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const smoothstep = (value: number) => value * value * (3 - 2 * value);

export default function LandingSpine() {
  const mounted = useSyncExternalStore(subscribeToHydration, getClientSnapshot, getServerSnapshot);
  const svgRef = useRef<SVGSVGElement>(null);
  const primaryRef = useRef<SVGPathElement>(null);
  const leftRef = useRef<SVGPathElement>(null);
  const rightRef = useRef<SVGPathElement>(null);
  const tailRef = useRef<SVGPathElement>(null);
  const beadRef = useRef<SVGGElement>(null);

  useEffect(() => {
    if (!mounted) return;
    const svg = svgRef.current;
    const zone = svg?.closest<HTMLElement>("[data-spine-zone]");
    const primary = primaryRef.current;
    const left = leftRef.current;
    const right = rightRef.current;
    const tail = tailRef.current;
    const bead = beadRef.current;
    if (!svg || !zone || !primary || !left || !right || !tail || !bead) return;

    const motionQuery = window.matchMedia(REDUCED_QUERY);
    const nodes = Array.from(zone.querySelectorAll<HTMLElement>("[data-spine-node]"));
    let height = 0;
    let nodeYs: number[] = [];
    let frame = 0;

    const measure = () => {
      height = zone.offsetHeight;
      const zoneRect = zone.getBoundingClientRect();
      nodeYs = nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return rect.top - zoneRect.top + rect.height / 2;
      });
      svg.setAttribute("viewBox", `0 0 80 ${height}`);
    };

    const updateNodes = (beadY: number) => {
      nodes.forEach((node, index) => {
        node.dataset.active = beadY >= nodeYs[index] ? "true" : "false";
      });
    };

    const step = (time: number) => {
      frame = 0;
      const rect = zone.getBoundingClientRect();
      if (rect.bottom < -120 || rect.top > window.innerHeight + 120 || height <= 0) return;

      const beadY = Math.max(0, Math.min(height, window.innerHeight * 0.55 - rect.top));
      const strand = (phase: number, side: -1 | 0 | 1) => {
        let d = "M 40 0";
        for (let y = 18; y <= height; y += 18) {
          const growth = 30 * Math.pow(Math.max(0, 1 - y / height), 1.35);
          const amplitude = smoothstep(clamp01((y - beadY) / 340));
          const spread = side * 24 * amplitude;
          const sideScale = side === 0 ? 1 : 0.8;
          const wave =
            growth *
            amplitude *
            sideScale *
            (0.7 * Math.sin(y * 0.017 + time * 0.000585 + phase) +
              0.5 * Math.sin(y * 0.006 - time * 0.00045 + 0.6 * phase));
          d += ` L ${(40 + spread + wave).toFixed(1)} ${y}`;
        }
        return `${d} L 40 ${height}`;
      };

      primary.setAttribute("d", strand(0, 0));
      left.setAttribute("d", strand(2.1, -1));
      right.setAttribute("d", strand(4.4, 1));
      tail.setAttribute(
        "d",
        `M 40 ${Math.max(0, beadY - 150).toFixed(0)} L 40 ${beadY.toFixed(0)}`
      );
      bead.setAttribute("transform", `translate(0 ${beadY.toFixed(1)})`);
      const travelling = beadY > 4 && beadY < height - 2;
      tail.style.opacity = travelling ? "1" : "0";
      bead.style.opacity = travelling ? "1" : "0";
      updateNodes(beadY);
      frame = requestAnimationFrame(step);
    };

    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };

    const resume = () => {
      if (!motionQuery.matches && !frame) frame = requestAnimationFrame(step);
    };

    const applyMotionPreference = () => {
      stop();
      if (motionQuery.matches) {
        zone.dataset.motionState = "reduced";
        nodes.forEach((node) => (node.dataset.active = "false"));
        return;
      }
      zone.dataset.motionState = "normal";
      measure();
      resume();
    };

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(zone);
    motionQuery.addEventListener("change", applyMotionPreference);
    window.addEventListener("scroll", resume, { passive: true });
    applyMotionPreference();

    return () => {
      stop();
      resizeObserver.disconnect();
      motionQuery.removeEventListener("change", applyMotionPreference);
      window.removeEventListener("scroll", resume);
      delete zone.dataset.motionState;
      nodes.forEach((node) => (node.dataset.active = "false"));
    };
  }, [mounted]);

  if (!mounted) return null;

  return (
    <svg
      ref={svgRef}
      data-spine-svg
      aria-hidden="true"
      viewBox="0 0 80 1000"
      preserveAspectRatio="none"
      className="landing-spine-svg"
    >
      <defs>
        <radialGradient id="landing-spine-bead-glow">
          <stop offset="0%" stopColor="rgba(250,250,250,0.95)" />
          <stop offset="70%" stopColor="rgba(250,250,250,0)" />
        </radialGradient>
        <filter id="landing-spine-bead-blur" x="-200%" y="-200%" width="500%" height="500%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <path
        ref={primaryRef}
        data-spine-strand="primary"
        fill="none"
        stroke="rgba(255,255,255,0.17)"
        strokeWidth="1"
      />
      <path
        ref={leftRef}
        data-spine-strand="left"
        fill="none"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1"
      />
      <path
        ref={rightRef}
        data-spine-strand="right"
        fill="none"
        stroke="rgba(255,255,255,0.10)"
        strokeWidth="1"
      />
      <path
        ref={tailRef}
        data-spine-tail
        fill="none"
        stroke="rgba(250,250,250,0.4)"
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity="0.5"
      />
      <g ref={beadRef} data-spine-bead>
        <circle
          cx="40"
          cy="0"
          r="11"
          fill="rgba(250,250,250,0.16)"
          filter="url(#landing-spine-bead-blur)"
        />
        <circle cx="40" cy="0" r="7.5" fill="url(#landing-spine-bead-glow)" />
      </g>
    </svg>
  );
}
