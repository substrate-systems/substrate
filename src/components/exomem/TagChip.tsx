import type { ReactNode } from "react";
import styles from "./TagChip.module.css";

/** A note's type, status or tag. `current` is the status that lights amber. */
export function TagChip({ children, current = false }: { children: ReactNode; current?: boolean }) {
  return (
    <span className={current ? `${styles.tag} ${styles.current}` : styles.tag}>{children}</span>
  );
}
