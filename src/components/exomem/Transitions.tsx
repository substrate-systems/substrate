"use client";

import { useEffect, useState, type ReactNode } from "react";
import styles from "./Transitions.module.css";

/** The supplied Swap transition, with outgoing content excluded from keyboard navigation. */
export function Swap({
  k,
  children,
  block = false,
  className,
}: {
  k: string | number;
  children: ReactNode;
  block?: boolean;
  className?: string;
}) {
  const [snapshot, setSnapshot] = useState({ k, children, old: null as ReactNode });
  if (snapshot.k !== k) setSnapshot({ k, children, old: snapshot.children });
  else if (snapshot.children !== children) setSnapshot({ ...snapshot, children });
  useEffect(() => {
    const timer = window.setTimeout(
      () => setSnapshot((current) => ({ ...current, old: null })),
      450
    );
    return () => window.clearTimeout(timer);
  }, [k]);
  const Element = block ? "div" : "span";
  return (
    <Element className={[styles.swap, block && styles.block, className].filter(Boolean).join(" ")}>
      {snapshot.old ? (
        <Element className={styles.out} aria-hidden inert>
          {snapshot.old}
        </Element>
      ) : null}
      <Element key={k} className={snapshot.old ? styles.in : undefined}>
        {children}
      </Element>
    </Element>
  );
}

/** Keep each pane mounted once; hidden panes cannot focus or announce a status. */
export function Crossfade({
  show,
  panes,
  className,
}: {
  show: string;
  panes: Record<string, ReactNode>;
  className?: string;
}) {
  return (
    <div className={[styles.crossfade, className].filter(Boolean).join(" ")}>
      {Object.entries(panes).map(([key, node]) => (
        <div
          key={key}
          className={`${styles.pane} ${key === show ? styles.on : ""}`}
          aria-hidden={key !== show || undefined}
          inert={key !== show}
        >
          {node}
        </div>
      ))}
    </div>
  );
}

export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[styles.collapse, open && styles.open, className].filter(Boolean).join(" ")}
      aria-hidden={!open || undefined}
      inert={!open}
    >
      <div>{children}</div>
    </div>
  );
}

export function FadeIn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={[styles.fadeIn, className].filter(Boolean).join(" ")}>{children}</div>;
}

export function Skeleton({
  width = "100%",
  height = 14,
}: {
  width?: number | string;
  height?: number;
}) {
  return <span className={styles.skeleton} aria-hidden style={{ width, height }} />;
}
