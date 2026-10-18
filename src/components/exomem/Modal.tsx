"use client";

import { useLayoutEffect, useId, useRef, type ReactNode } from "react";
import styles from "./Modal.module.css";
import { Swap } from "./Transitions";

type ModalProps = {
  open: boolean;
  /** Called on Esc and wherever the caller offers a way out. */
  onClose: () => void;
  /** The current step's title ("Checking your vault" → "Ready to bring in"). */
  title: string;
  /** The current step (ask → working → done) is the caller's. */
  children: ReactNode;
  /**
   * The Home board's content width for this modal, inside its 24 px padding: 360 (signed
   * out, billing), 400 (delete) or 420 (storage, import, restore, email).
   */
  width?: 360 | 400 | 420;
  /** Home's storage board uses the whole phone width. */
  phoneFullWidth?: boolean;
  /** The email-change frames start 120 px below the top of the viewport. */
  placement?: "center" | "top";
};

const WIDTH_CLASS = { 360: styles.w360, 400: styles.w400, 420: styles.w420 };

/**
 * A modal dialog over a scrim. The native <dialog> in modal mode makes the page
 * behind it inert, so focus stays inside, and turns Esc into `cancel`.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  width = 420,
  phoneFullWidth = false,
  placement = "center",
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => {
      // Close before removal so the browser restores the invoking element.
      if (dialog.open) dialog.close();
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={`${styles.modal} ${WIDTH_CLASS[width]} ${phoneFullWidth ? styles.phoneFullWidth : ""} ${placement === "top" ? styles.top : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Esc: the caller decides what closing means for its current step.
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId} className={styles.title}>
        <Swap k={title}>{title}</Swap>
      </h2>
      {children}
    </dialog>
  );
}
