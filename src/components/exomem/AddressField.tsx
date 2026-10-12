"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./AddressField.module.css";
import phone from "./phone.module.css";

const COPIED_MS = 1600;

/** Splits a URL after its host ("https://substratesystems.io/"), the one place it may wrap. */
function splitAfterHost(address: string): [string, string] | null {
  try {
    const url = new URL(address);
    const head = `${url.origin}/`;
    return address.startsWith(head) ? [head, address.slice(head.length)] : null;
  } catch {
    return null;
  }
}

type AddressFieldProps = {
  label: string;
  address: string;
  /** page: the flow's field · row: Home's compact field inside a panel row (44 px, a 32 px Copy). */
  size?: "page" | "row";
  /** The page already says what the address is for: the label only names the field for screen readers. */
  labelHidden?: boolean;
};

/** An address to paste elsewhere (the MCP address), with Copy inside on the right. */
export function AddressField({
  label,
  address,
  size = "page",
  labelHidden = false,
}: AddressFieldProps) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  // "Copied ✓" only once the clipboard took the address; refused or unavailable keeps "Copy".
  const copy = () => {
    navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {
        // Refused (no permission): the address stays visible to copy by hand.
      }
    );
  };

  const parts = splitAfterHost(address);
  return (
    <div className={size === "row" ? `${styles.field} ${styles.row}` : styles.field}>
      <span className={labelHidden ? styles.labelHidden : styles.label} id={id}>
        {label}
      </span>
      <div className={styles.box} role="group" aria-labelledby={id}>
        <span className={styles.address}>
          {parts ? (
            <>
              <span className={styles.part}>{parts[0]}</span>
              <wbr />
              <span className={styles.part}>{parts[1]}</span>
            </>
          ) : (
            address
          )}
        </span>
        <button
          type="button"
          className={`${styles.copy} ${phone.hitArea}`}
          onClick={copy}
          aria-live="polite"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}
