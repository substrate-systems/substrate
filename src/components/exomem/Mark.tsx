import type { CSSProperties } from "react";
import { DOT_E_INK, DOT_E_LIT, DOT_E_RADIUS } from "./dot-e";
import styles from "./Mark.module.css";

// Home's stagger between the lit dots, from the board (0, .35, .7, 1.05 s).
const BREATH_STEP_S = 0.35;

type MarkProps = {
  size: number;
  /**
   * Home's status mark. on: the memory is live, so every dot is amber and the middle row
   * breathes · off: not live (read-only, ended), so the middle row is faint ink. Omitted:
   * the Dot E icon, its middle row amber.
   */
  status?: "on" | "off";
  /** Names the mark for screen readers; omit when the mark sits inside a labelled control. */
  label?: string;
};

/** The Dot E icon: the E in dots, its middle row amber. */
export function Mark({ size, status, label }: MarkProps) {
  const ink = status === "on" ? styles.lit : styles.ink;
  const row = status === "off" ? styles.unlit : styles.lit;
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={status === "on" ? styles.breathing : undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {DOT_E_INK.map(([cx, cy]) => (
        <circle key={`${cx},${cy}`} className={ink} cx={cx} cy={cy} r={DOT_E_RADIUS} />
      ))}
      {DOT_E_LIT.map(([cx, cy], i) => (
        <circle
          key={`${cx},${cy}`}
          className={`${row} ${styles.row}`}
          cx={cx}
          cy={cy}
          r={DOT_E_RADIUS}
          style={{ "--ed": `${i * BREATH_STEP_S}s` } as CSSProperties}
        />
      ))}
    </svg>
  );
}
