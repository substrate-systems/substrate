import type { ReactNode } from "react";
import styles from "./Row.module.css";

type RowProps = {
  title: ReactNode;
  meta?: ReactNode;
  /** Makes the row a button; hovering it lights the title. */
  onSelect?: () => void;
};

/** One line of a list: a title and its metadata, divided from the next. */
export function Row({ title, meta, onSelect }: RowProps) {
  const content = (
    <>
      <span className={styles.title}>{title}</span>
      {meta !== undefined && <span className={styles.meta}>{meta}</span>}
    </>
  );
  if (!onSelect) return <div className={styles.row}>{content}</div>;
  return (
    <button type="button" className={`${styles.row} ${styles.interactive}`} onClick={onSelect}>
      {content}
    </button>
  );
}
