import type { ReactNode } from "react";
import styles from "./Popover.module.css";

/** A small surface over the page (the relations list, the music menu). The caller positions it. */
export function Popover({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={styles.popover} role="group" aria-label={label}>
      {children}
    </div>
  );
}
