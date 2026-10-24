"use client";

import * as React from "react";
import { FULL, FULL_ROW, SMALL, SMALL_ROW } from "./dot-e";
import { markNumbers, type MarkState } from "./writing-e";
import styles from "./Mark.module.css";

const { useState, useEffect } = React;
const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

/** 'failed' un-writes the stroke, then rests. */
export function useSettled(state: MarkState): MarkState {
  const [current, setCurrent] = useState({ requested: state, settled: state });
  if (current.requested !== state) setCurrent({ requested: state, settled: state });
  useEffect(() => {
    if (state !== "failed") return;
    const t = setTimeout(() => setCurrent({ requested: state, settled: "rest" }), 950);
    return () => clearTimeout(t);
  }, [state]);
  return current.requested === state ? current.settled : state;
}

export function Dots({ pts, row, r }: { pts: [number, number][]; row: number[]; r: number }) {
  const c = pts.map(([x, y], k) => (
    <circle
      key={k}
      cx={x}
      cy={y}
      r={r}
      style={{
        ["--exo-k" as keyof React.CSSProperties]: k,
        ["--exo-row" as keyof React.CSSProperties]: row.includes(k) ? 1 : 0,
      }}
    />
  ));
  return (
    <>
      <g className={styles.ink}>{c}</g>
      <g className={styles.lit}>{c}</g>
      <g className={styles.pen}>{c}</g>
    </>
  );
}

export interface MarkProps {
  /** Pixel size. Below 32 px the small cut is used. */
  size?: number;
  state?: MarkState;
  /** progress: how many steps, and which one is running (0-based; steps = done). */
  steps?: number;
  step?: number;
  /** progress: a fraction 0–1 instead of steps. */
  value?: number;
  /** At rest the middle row breathes. Set false for a still logo. */
  breathe?: boolean;
  /** Accessible name. Defaults to "Exomem". Pass null to hide it from assistive tech. */
  label?: string | null;
  small?: boolean;
  className?: string;
  status?: "on" | "off";
  /**
   * The Journey tile's own drawing of a mark at rest (Journey board .ed / .md), in ink only:
   * "idle" dims the middle row to .55 and lets it breathe; "stopped" holds the frame at .5
   * and the row at .3. Use it with state "off".
   */
  tile?: "idle" | "stopped";
}

/** The Dot E, alive: the logo at rest, a meter that writes itself while work runs. */
export function Mark({
  size = 40,
  state = "rest",
  steps,
  step,
  value,
  breathe = true,
  label = null,
  small,
  className,
  status,
  tile,
}: MarkProps) {
  const s = useSettled(status === "off" ? "off" : status === "on" ? "done" : state);
  const sm = small ?? size < 32;
  const L = sm ? 10 : 18;
  const n = markNumbers(L, s, { steps, step, value });
  const cls = n.cls === "breathe" && !breathe ? "" : n.cls;
  return (
    <svg
      className={cx(
        styles.mark,
        cls && styles[cls],
        tile === "idle" && styles.tileIdle,
        tile === "stopped" && styles.tileStopped,
        className
      )}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      style={{
        ["--exo-L" as keyof React.CSSProperties]: L,
        ["--exo-w" as keyof React.CSSProperties]: n.w,
        ["--exo-b" as keyof React.CSSProperties]: n.b,
        ["--exo-rest" as keyof React.CSSProperties]: n.rest,
      }}
    >
      {sm ? (
        <Dots pts={SMALL} row={SMALL_ROW} r={3.1} />
      ) : (
        <Dots pts={FULL} row={FULL_ROW} r={2.2} />
      )}
    </svg>
  );
}
