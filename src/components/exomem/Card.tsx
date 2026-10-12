import type { ReactNode } from "react";
import styles from "./Card.module.css";

/** A panel on the page: a quiet frame around one group of facts. */
export function Card({ children }: { children: ReactNode }) {
  return <div className={styles.card}>{children}</div>;
}
