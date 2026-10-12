import type { ButtonHTMLAttributes, ComponentProps } from "react";
import Link from "next/link";
import phone from "./phone.module.css";
import styles from "./Button.module.css";

type Variant = "primary" | "secondary" | "amber" | "ghost";
/**
 * panel: h 36 inside panels · page: h 48, a page's main action · landing: the landing's
 * calls to action (a full-width 52 px block on a phone) · row: h 44 and at least 112 wide,
 * a row's action on Home · detail: h 36 and at least 112 wide, the action of a line under a
 * row or of a notice. Ghost buttons have one size.
 */
type Size = "panel" | "page" | "landing" | "row" | "detail";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  /** primary: the one main action · secondary: bordered · amber: epistemic actions only · ghost: text only. */
  variant?: Variant;
  size?: Size;
  /** Shows the button as working: the label (the caller's) says what happens; clicks do nothing. */
  working?: boolean;
};

function buttonClasses(variant: Variant, size: Size): string {
  return [
    styles.button,
    phone.hitArea,
    variant !== "secondary" && styles[variant],
    variant !== "ghost" && size !== "panel" && styles[size],
  ]
    .filter(Boolean)
    .join(" ");
}

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
  return (
    <button
      {...rest}
      type={type}
      className={buttonClasses(variant, size)}
      aria-busy={working || undefined}
      aria-disabled={working || rest["aria-disabled"]}
      // Working: a click does nothing, and a submit button does not submit its form again.
      onClick={working ? (event) => event.preventDefault() : onClick}
    />
  );
}

type ButtonLinkProps = Omit<ComponentProps<typeof Link>, "className"> & {
  variant?: Variant;
  size?: Size;
};

/** A link that looks like an Exomem button: the action goes to another page. */
export function ButtonLink({ variant = "secondary", size = "panel", ...rest }: ButtonLinkProps) {
  return <Link {...rest} className={`${buttonClasses(variant, size)} ${styles.link}`} />;
}
