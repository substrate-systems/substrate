"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import styles from "./TextField.module.css";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> & {
  label: string;
  /**
   * A failed attempt: one generic message. It never says which part failed or
   * whether an account exists.
   */
  error?: ReactNode;
};

/** A labelled text input. */
export function TextField({ label, error, ...input }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hasError = error !== undefined && error !== null && error !== false;
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input
        {...input}
        id={id}
        className={styles.input}
        aria-invalid={hasError || undefined}
        aria-describedby={hasError ? errorId : input["aria-describedby"]}
      />
      {hasError && (
        <div id={errorId} className={styles.error} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
