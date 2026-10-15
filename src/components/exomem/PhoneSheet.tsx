import type { ReactNode } from "react";
import phone from "./phone.module.css";
import styles from "./PhoneSheet.module.css";

type PhoneSheetProps = {
  /** Open (56% of the screen) or peeking (188 px). */
  open: boolean;
  onToggle: () => void;
  /** Reuse the same content as the viewer's fixed desktop panel. */
  desktopPanel?: boolean;
  children: ReactNode;
};

/** The phone's bottom sheet: details rise in it, first peeking, then open. */
export function PhoneSheet({ open, onToggle, desktopPanel = false, children }: PhoneSheetProps) {
  return (
    <div
      className={[styles.sheet, open && styles.open, desktopPanel && styles.desktopPanel]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className={`${styles.handle} ${phone.hitArea}`}
        onClick={onToggle}
        aria-label={open ? "Lower the panel" : "Raise the panel"}
        aria-expanded={open}
      >
        <span className={styles.bar} />
      </button>
      <div className={styles.body}>{children}</div>
    </div>
  );
}
