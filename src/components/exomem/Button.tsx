import type { ButtonHTMLAttributes } from "react";
import phone from "./phone.module.css";
import styles from "./Button.module.css";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  /** primary: the one main action · secondary: bordered · amber: epistemic actions only · ghost: text only. */
  variant?: "primary" | "secondary" | "amber" | "ghost";
  /**
   * panel: h 36 inside panels · page: h 48, a page's main action · row: h 44 and at least
   * 112 wide, a row's action on Home · detail: h 36 and at least 112 wide, the action of a
   * line under a row or of a notice. Ghost buttons have one size.
   */
  size?: "panel" | "page" | "row" | "detail";
  /** Shows the button as working: the label (the caller's) says what happens; clicks do nothing. */
  working?: boolean;
};

/**
 * The Exomem button. A disabled button keeps the reason in its label
 * ("Send another link in 0:42"); a working one changes its label ("Connecting…").
 */
export function Button({
  variant = "secondary",
  size = "panel",
  working = false,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  const classes = [
    styles.button,
    phone.hitArea,
    variant !== "secondary" && styles[variant],
    variant !== "ghost" && size !== "panel" && styles[size],
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      {...rest}
      type={type}
      className={classes}
      aria-busy={working || undefined}
      aria-disabled={working || rest["aria-disabled"]}
      // Working: a click does nothing, and a submit button does not submit its form again.
      onClick={working ? (event) => event.preventDefault() : onClick}
    />
  );
}
