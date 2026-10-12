"use client";

import { useCallback, useState } from "react";
import styles from "./email-preview.module.css";

/**
 * One email in an iframe, already forced to one scheme by the page. The
 * iframe's color-scheme only matches the browser's own canvas to it.
 */
export function EmailFrame({
  html,
  scheme,
  title,
}: {
  html: string;
  scheme: "dark" | "light";
  title: string;
}) {
  const [height, setHeight] = useState<number | null>(null);
  // The document may finish loading before hydration attaches onLoad, so the ref
  // measures a loaded document at once and listens for a later load.
  const frameRef = useCallback((frame: HTMLIFrameElement | null) => {
    if (!frame) return;
    const measure = () => {
      const body = frame.contentDocument?.body;
      if (body) setHeight(body.scrollHeight);
    };
    if (frame.contentDocument?.readyState === "complete") measure();
    frame.addEventListener("load", measure);
  }, []);
  return (
    <iframe
      ref={frameRef}
      className={styles.frame}
      title={title}
      srcDoc={html}
      style={{ colorScheme: scheme, height: height ?? undefined }}
    />
  );
}
