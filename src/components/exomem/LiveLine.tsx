import type { ReactNode } from "react";
import { Button } from "./Button";
import styles from "./LiveLine.module.css";

type LiveLineProps = {
  /** One line about what is happening now ("Claude Code recalled 4 notes · 12 s ago"). */
  children: ReactNode;
  paused?: boolean;
  /** Offers Pause / Resume (the viewer). */
  onTogglePause?: () => void;
};

/** A blinking amber dot and one line: the memory is in use right now. */
export function LiveLine({ children, paused = false, onTogglePause }: LiveLineProps) {
  return (
    <span className={paused ? `${styles.live} ${styles.paused}` : styles.live}>
      <span className={styles.dot} aria-hidden="true" />
      <span>{children}</span>
      {onTogglePause && (
        <Button variant="ghost" onClick={onTogglePause}>
          {paused ? "Resume" : "Pause"}
        </Button>
      )}
    </span>
  );
}
