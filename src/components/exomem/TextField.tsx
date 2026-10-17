"use client";

import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Collapse, Swap } from "./Transitions";
import styles from "./TextField.module.css";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> & {
  label: string;
  /**
   * A failed attempt: one generic message. It never says which part failed or
   * whether an account exists.
   */
  error?: ReactNode;
  /**
   * A failed attempt whose message the page shows elsewhere, such as a notice above
   * the form: the field draws the error border without a message of its own.
   */
  invalid?: boolean;
  hint?: string;
  /**
   * Where the field sits. "page": straight on a flow page, drawn in the flow's panel
   * colour with its stronger line. "panel" (the default): inside a card or a form panel.
   */
  surface?: "panel" | "page";
};

/** A labelled text input. */
export function TextField({
  label,
  error,
  invalid = false,
  hint,
  surface = "panel",
  onChange,
  onBlur,
  onInvalid,
  ...input
}: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const [localError, setLocalError] = useState<string | null>(null);
  const message = error ?? localError;
  const hasError = message !== undefined && message !== null && message !== false && message !== "";
  const hasLine = hasError || Boolean(hint);
  const judge = (field: HTMLInputElement) => {
    setLocalError(
      field.validity.valid
        ? null
        : field.type === "email"
          ? "Enter a valid email address."
          : `Enter ${label.toLowerCase()}.`
    );
  };
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        {...input}
        id={id}
        className={surface === "page" ? `${styles.input} ${styles.onPage}` : styles.input}
        aria-invalid={hasError || invalid || undefined}
        aria-describedby={
          [hasLine ? errorId : undefined, input["aria-describedby"]].filter(Boolean).join(" ") ||
          undefined
        }
        onChange={(event) => {
          if (localError) judge(event.currentTarget);
          onChange?.(event);
        }}
        onBlur={(event) => {
          judge(event.currentTarget);
          onBlur?.(event);
        }}
        onInvalid={(event) => {
          event.preventDefault();
          judge(event.currentTarget);
          onInvalid?.(event);
        }}
      />
      <Collapse open={hasLine}>
        <div
          id={errorId}
          className={`${styles.line} ${hasError ? styles.error : ""}`}
          data-step-status={hasError || undefined}
        >
          <Swap k={hasError ? String(message) : "hint"}>{message ?? hint ?? ""}</Swap>
        </div>
      </Collapse>
    </div>
  );
}
