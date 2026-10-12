"use client";

import { useEffect, useRef, useState } from "react";
import phone from "@/components/exomem/phone.module.css";
import styles from "./PipInstall.module.css";

const COMMAND = "pip install exomem";
const COPIED_MS = 1600;

/**
 * "$ pip install exomem" with Copy: bordered beside the hero's main action, or a filled
 * box in the self-host door. "Copied" shows only once the clipboard took the command.
 */
export function PipInstall({ look }: { look: "hero" | "door" }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = () => {
    navigator.clipboard?.writeText(COMMAND).then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      },
      () => {
        // Refused (no permission): the command stays on screen to copy by hand.
      }
    );
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${COMMAND}`}
      className={`${styles.pip} ${styles[look]} ${phone.hitArea}`}
    >
      <span>
        <span className={styles.prompt}>$</span> {COMMAND}
      </span>
      <span className={styles.copy} aria-live="polite">
        {copied ? "Copied" : "Copy"}
      </span>
    </button>
  );
}
