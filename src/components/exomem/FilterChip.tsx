import type { ReactNode } from "react";
import styles from "./FilterChip.module.css";

/** The 22 × 6 sample of a relation's line style, drawn from that relation's own settings. */
type LineSample = {
  /** A token reference, e.g. "var(--exo-amber)". */
  stroke: string;
  width: number;
  /** An SVG dash array, e.g. "1 3"; omit for a solid line. */
  dash?: string;
  opacity: number;
};

type FilterChipProps = {
  children: ReactNode;
  /** Shown (true) or hidden (false). Omit for a chip that opens something instead (review). */
  pressed?: boolean;
  onClick?: () => void;
  line?: LineSample;
  /** The amber review chip ("19 to review"). */
  review?: boolean;
  title?: string;
};

/** A filter chip: toggles one relation type on the map, with a sample of its line. */
export function FilterChip({
  children,
  pressed,
  onClick,
  line,
  review = false,
  title,
}: FilterChipProps) {
  return (
    <button
      type="button"
      className={review ? `${styles.chip} ${styles.review}` : styles.chip}
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
    >
      {line && (
        <svg width="22" height="6" aria-hidden="true">
          <line
            x1="1"
            y1="3"
            x2="21"
            y2="3"
            stroke={line.stroke}
            strokeWidth={line.width}
            strokeDasharray={line.dash}
            strokeOpacity={line.opacity}
          />
        </svg>
      )}
      {children}
    </button>
  );
}
