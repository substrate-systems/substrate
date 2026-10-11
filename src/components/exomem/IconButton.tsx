import type { ButtonHTMLAttributes } from "react";
import styles from "./IconButton.module.css";

type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  /** The name a screen reader announces; the icon itself is decorative. */
  label: string;
};

/** A borderless square button around one icon: the theme toggle, the speaker. */
export function IconButton({ label, type = "button", title, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={styles.iconButton}
    />
  );
}
