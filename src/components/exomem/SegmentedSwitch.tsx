import type { ReactNode } from "react";
import styles from "./SegmentedSwitch.module.css";

type Option<T extends string> = { value: T; label: string };

type SegmentedSwitchProps<T extends string> = {
  /** The group's accessible name, e.g. "How much your app uses Exomem". */
  label: string;
  /** The segments, in order (the involvement levels come from their own data). */
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  /** What the selected segment does; its line keeps its height across segments. */
  description?: ReactNode;
  /** page: a flow page's switch · row: Home's compact rows. */
  size?: "page" | "row";
};

/** One choice from a few segments, the selected one filled. */
export function SegmentedSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
  description,
  size = "page",
}: SegmentedSwitchProps<T>) {
  return (
    <div className={size === "row" ? `${styles.wrap} ${styles.row}` : styles.wrap}>
      <div role="group" aria-label={label} className={styles.track}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.segment}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {description !== undefined && <div className={styles.description}>{description}</div>}
    </div>
  );
}
