"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./AddressField.module.css";

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

/** An address to paste elsewhere (the MCP address), with Copy inside on the right. */
export function AddressField({ label, address }: { label: string; address: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = () => {
    try {
      navigator.clipboard?.writeText(address).catch(() => {
        // Refused (no permission): the address stays visible to copy by hand.
      });
    } catch {
      // No clipboard (insecure context): the address stays visible to copy by hand.
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  const parts = splitAfterHost(address);
  return (
    <div className={styles.field}>
      <span className={styles.label} id={id}>
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
        <button type="button" className={styles.copy} onClick={copy} aria-live="polite">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </div>
  );
}
