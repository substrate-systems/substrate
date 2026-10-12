import type { ReactNode } from "react";
import { Button } from "./Button";
import styles from "./LiveLine.module.css";

type LiveLineProps = {
  /** One line about what is happening now ("Claude Code recalled 4 notes · 12 s ago"). */
  children: ReactNode;
  paused?: boolean;
  /** Offers Pause / Resume (the viewer). */
  onTogglePause?: () => void;
  /** viewer: the viewer's header line · home: Home's status line, quieter and a size up. */
  variant?: "viewer" | "home";
  /**
   * Home: names the event the line describes. When it changes, the text fades in again;
   * a ticking time ("12 s ago" → "13 s ago") keeps the same key and holds still.
   */
  eventKey?: string;
};

/** A blinking amber dot and one line: the memory is in use right now. */
export function LiveLine({
  children,
  paused = false,
  onTogglePause,
  variant = "viewer",
  eventKey,
}: LiveLineProps) {
  const classes = [styles.live, variant === "home" && styles.home, paused && styles.paused]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes}>
      <span className={styles.dot} aria-hidden="true" />
      <span key={eventKey} className={styles.text}>
        {children}
      </span>
      {onTogglePause && (
        <Button variant="ghost" onClick={onTogglePause}>
          {paused ? "Resume" : "Pause"}
        </Button>
      )}
    </span>
  );
}
