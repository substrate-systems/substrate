import type { CSSProperties } from "react";
import { DOT_E_INK, DOT_E_LIT, DOT_E_RADIUS } from "./dot-e";
import styles from "./Mark.module.css";

// Home's stagger between the lit dots, from the board (0, .35, .7, 1.05 s).
const BREATH_STEP_S = 0.35;

type MarkProps = {
  size: number;
  /** Home, while the memory is on: the lit row breathes. */
  breathing?: boolean;
  /** Names the mark for screen readers; omit when the mark sits inside a labelled control. */
  label?: string;
};

/** The Dot E icon: the E in dots, its middle row amber. */
export function Mark({ size, breathing = false, label }: MarkProps) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={breathing ? styles.breathing : undefined}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {DOT_E_INK.map(([cx, cy]) => (
        <circle key={`${cx},${cy}`} className={styles.ink} cx={cx} cy={cy} r={DOT_E_RADIUS} />
      ))}
      {DOT_E_LIT.map(([cx, cy], i) => (
        <circle
          key={`${cx},${cy}`}
          className={styles.lit}
          cx={cx}
          cy={cy}
          r={DOT_E_RADIUS}
          style={{ "--ed": `${i * BREATH_STEP_S}s` } as CSSProperties}
        />
      ))}
    </svg>
  );
}
