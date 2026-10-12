import type { ReactNode } from "react";
import styles from "./Notice.module.css";

type NoticeProps = {
  children: ReactNode;
  /** The notice's one action, usually a secondary <Button>. */
  action?: ReactNode;
  /** Amber edge: a live state that needs the person now (storage full). */
  attention?: boolean;
  /** column: action under the text at every width · row: Home's desktop notice, action on the right above 640 px. */
  layout?: "column" | "row";
  /** home: the Home board's notice · flow: the Journey board's, a step's notice (13.5 px). */
  size?: "home" | "flow";
};

/** A notice, shown only while it is true: what happened, and the one thing to do. */
export function Notice({
  children,
  action,
  attention = false,
  layout = "column",
  size = "home",
}: NoticeProps) {
  const classes = [
    styles.notice,
    attention && styles.attention,
    layout === "row" && styles.row,
    size === "flow" && styles.flow,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes}>
      <span className={styles.text}>{children}</span>
      {action}
    </div>
  );
}
