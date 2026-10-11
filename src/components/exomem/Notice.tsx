import type { ReactNode } from "react";
import styles from "./Notice.module.css";

type NoticeProps = {
  children: ReactNode;
  /** The notice's one action, usually a secondary <Button>. */
  action?: ReactNode;
  /** Amber edge: a live state that needs the person now (storage full). */
  attention?: boolean;
};

/** A notice, shown only while it is true: what happened, and the one thing to do. */
export function Notice({ children, action, attention = false }: NoticeProps) {
  return (
    <div className={attention ? `${styles.notice} ${styles.attention}` : styles.notice}>
      <span className={styles.text}>{children}</span>
      {action}
    </div>
  );
}
