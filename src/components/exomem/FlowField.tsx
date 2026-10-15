"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AliveGraph, type AliveEvent } from "./AliveGraph";
import { buildFieldLayout } from "./flow-field-layout";
import phoneStyles from "./phone.module.css";
import styles from "./FlowField.module.css";

export type FieldKind = "quiet" | "live" | "hold" | "go" | "done" | "stop";

/** The board's field geometry, with the shared A + loop motion engine. */
export function FlowField({
  kind,
  footer = false,
  activity,
}: {
  kind: FieldKind;
  footer?: boolean;
  activity?: AliveEvent;
}) {
  const host = useRef<HTMLDivElement>(null);
  const id = useId();
  const [size, setSize] = useState<{ width: number; height: number; phone: boolean } | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      const phone = getComputedStyle(element).getPropertyValue("--field-phone").trim() === "1";
      setSize((old) =>
        old?.width === width && old.height === height && old.phone === phone
          ? old
          : { width, height, phone }
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const graph = useMemo(() => {
    if (!size) return null;
    const width = size.phone ? 390 : 1280;
    const layout = buildFieldLayout(
      width,
      Math.round((size.height * width) / size.width),
      size.phone,
      footer
    );
    return {
      nodes: layout.nodes.map((n): [number, number, number] => [
        n.x + n.s / 2,
        n.y + n.s / 2,
        n.s / 2,
      ]),
      edges: layout.edges
        .filter((e) => e.base || kind === "go" || kind === "done")
        .map((e): [number, number] => [e.i, e.j]),
      viewBox: `0 0 ${layout.vw} ${layout.vh}`,
    };
  }, [size, footer, kind]);
  const event = useMemo<AliveEvent | undefined>(
    () =>
      activity ??
      (kind === "go" || kind === "done"
        ? { kind: "connect" }
        : kind === "hold"
          ? { kind: "work", on: true }
          : undefined),
    [activity, kind]
  );
  return (
    <div ref={host} className={`${styles.field} ${phoneStyles.fieldLayout}`} aria-hidden>
      {graph ? (
        <AliveGraph
          {...graph}
          id={`field-${id}`}
          className={styles.canvas}
          state={kind === "stop" ? "cut" : "live"}
          hover={kind !== "hold"}
          event={event}
        />
      ) : null}
    </div>
  );
}
