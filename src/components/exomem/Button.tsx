import type { ButtonHTMLAttributes, ComponentProps, Ref } from "react";
import Link from "next/link";
import phone from "./phone.module.css";
import styles from "./Button.module.css";

type Variant = "primary" | "secondary" | "quiet" | "amber" | "ghost";
/**
 * panel: h 36 inside panels · page: h 48, a page's main action · landing: the landing's
 * calls to action (a full-width 52 px block on a phone) · row: h 44 and at least 112 wide,
 * a row's action on Home · account: the row size at 12.5 px, Home's billing and export
 * actions (500 when filled) · detail: h 36 and at least 112 wide, the action of a line
 * under a row or of a notice. A ghost button is panel (back links, "Copy path") or page:
 * a flow page's quiet second action under its main one. Dialog actions use the Home
 * boards' 46 px primary, 44 px secondary and 40 px quiet controls.
 */
type Size = "panel" | "page" | "landing" | "row" | "account" | "detail" | "dialog";

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & {
  ref?: Ref<HTMLButtonElement>;
  /**
   * primary: the one main action · secondary: bordered · quiet: bordered, in the secondary
   * ink, an action that takes something away (Home's Disconnect) · amber: epistemic actions
   * only · ghost: text only.
   */
  variant?: Variant;
  size?: Size;
  /** Shows the button as working: the label (the caller's) says what happens; clicks do nothing. */
  working?: boolean;
  /**
   * Disabled until a wait ends, and the label counts it down ("Send again in 0:42"). The
   * Journey board keeps that label readable: a main action dims less, a quiet one not at all.
   */
  countdown?: boolean;
};

function buttonClasses(variant: Variant, size: Size, countdown = false): string {
  return [
    styles.button,
    phone.hitArea,
    variant !== "secondary" && styles[variant],
    variant !== "ghost" && size !== "panel" && styles[size],
    variant === "ghost" && size === "page" && styles.ghostPage,
    variant === "ghost" && size === "dialog" && styles.ghostDialog,
    countdown && styles.countdown,
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
  countdown = false,
  type = "button",
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={buttonClasses(variant, size, countdown)}
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
