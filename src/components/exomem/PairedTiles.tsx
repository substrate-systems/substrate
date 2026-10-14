"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Mark } from "./Mark";
import phone from "./phone.module.css";
import styles from "./PairedTiles.module.css";

type PairedTilesProps = {
  /** idle: asking · connecting: the dot travels · connected: the Exomem tile blooms · stopped: the light is out. */
  state: "idle" | "connecting" | "connected" | "stopped";
  /** The app asking to connect. Omit when the person started on our site: only the Exomem tile shows. */
  app?: { name: string; glyph: ReactNode; glyphSize: number };
  onMotionComplete?: (state: "connecting" | "connected") => void;
};

/** The consent page's pairing: the app's tile, a line, and the Exomem tile. */
export function PairedTiles({ state, app, onMotionComplete }: PairedTilesProps) {
  const tiles = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!onMotionComplete || (state !== "connecting" && state !== "connected")) return;
    let active = true;
    let timer = 0;
    const frame = requestAnimationFrame(() => {
      const animations = tiles.current?.getAnimations({ subtree: true }) ?? [];
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (state === "connecting" || reduced || !animations.length) {
        // One complete visible cycle survives a fast provider response; reduced motion settles statically.
        const duration = reduced
          ? 140
          : Math.max(
              140,
              ...animations.map((animation) => Number(animation.effect?.getTiming().duration) || 0)
            );
        timer = window.setTimeout(() => active && onMotionComplete(state), duration);
      } else {
        const finite = animations.filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity
        );
        void Promise.allSettled(finite.map((animation) => animation.finished)).then(() => {
          if (active) onMotionComplete(state);
        });
      }
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [state, onMotionComplete]);
  return (
    <div
      ref={tiles}
      className={`${styles.tiles} ${phone.pairLine} ${state === "idle" ? "" : styles[state]}`}
    >
      {app && (
        <>
          <div className={styles.tile} title={app.name} style={{ fontSize: app.glyphSize }}>
            <span aria-hidden="true">{app.glyph}</span>
            <span className={styles.appName}>{app.name}</span>
          </div>
          <svg className={styles.pair} height="10" aria-hidden="true">
            <line className={styles.pl} x1="4" y1="5" x2="100%" y2="5" strokeWidth="1.5" />
            <circle className={styles.pd} cx="4" cy="5" r="2.6" />
          </svg>
        </>
      )}
      <div className={`${styles.tile} ${styles.xt}`}>
        <Mark
          size={42}
          state={state === "connecting" ? "working" : state === "connected" ? "done" : "off"}
          label="Exomem"
        />
      </div>
    </div>
  );
}
