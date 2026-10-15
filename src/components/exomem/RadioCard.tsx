import type { ReactNode } from "react";
import styles from "./RadioCard.module.css";

/** The Home board's pack selector, with native radio keyboard behavior. */
export function RadioCard({
  name,
  value,
  checked,
  onChange,
  children,
  detail,
  disabled = false,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  detail: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={styles.row}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span className={styles.label}>{children}</span>
      <span className={styles.detail}>{detail}</span>
    </label>
  );
}
