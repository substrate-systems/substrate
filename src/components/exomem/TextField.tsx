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
  /** The message that sets the space before an error appears. */
  errorSpace?: ReactNode;
  /**
   * A failed attempt whose message the page shows elsewhere, such as a notice above
   * the form: the field draws the error border without a message of its own.
   */
  invalid?: boolean;
};

/** A labelled text input. */
export function TextField({ label, error, errorSpace, invalid = false, ...input }: TextFieldProps) {
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
        aria-invalid={hasError || invalid || undefined}
        aria-describedby={hasError ? errorId : input["aria-describedby"]}
      />
      {(hasError || errorSpace) && (
        <div
          id={errorId}
          className={styles.error}
          role={hasError ? "alert" : undefined}
          style={hasError ? undefined : { visibility: "hidden" }}
          aria-hidden={!hasError || undefined}
        >
          {errorSpace ? (
            <span className={styles.errorSpace} aria-hidden="true">
              {errorSpace}
            </span>
          ) : null}
          <span className={styles.errorText}>{hasError ? error : errorSpace}</span>
        </div>
      )}
    </div>
  );
}
