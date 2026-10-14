"use client";

import * as React from "react";
import { FULL, FULL_ROW, WORD_PATH } from "./dot-e";
import { Dots, useSettled, type MarkProps } from "./Mark";
import { markNumbers } from "./writing-e";
import styles from "./Mark.module.css";
const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");

export interface WordmarkProps extends Omit<MarkProps, "size" | "small"> {
  /** Height in px. The header uses 17. */
  height?: number;
}

/** The logo: the word Exomem with the Dot E as its capital. Every Mark state works here. */
export function Wordmark({
  height = 17,
  state = "rest",
  steps,
  step,
  value,
  breathe = false,
  label = "Exomem",
  className,
}: WordmarkProps) {
  const s = useSettled(state);
  const n = markNumbers(18, s, { steps, step, value });
  const cls = n.cls === "breathe" && !breathe ? "" : n.cls;
  return (
    <svg
      className={cx(`${styles.mark} ${styles.wordmark}`, cls && styles[cls], className)}
      viewBox="2.30 -27.92 139.90 28.40"
      height={height}
      role={label ? "img" : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      style={{
        ["--exo-L" as keyof React.CSSProperties]: 18,
        ["--exo-w" as keyof React.CSSProperties]: n.w,
        ["--exo-b" as keyof React.CSSProperties]: n.b,
        ["--exo-rest" as keyof React.CSSProperties]: n.rest,
      }}
    >
      <g transform="translate(-6.642 -32.782) scale(0.7843)">
        <Dots pts={FULL} row={FULL_ROW} r={2.2} />
      </g>
      <path className={styles.word} d={WORD_PATH} />
    </svg>
  );
}
