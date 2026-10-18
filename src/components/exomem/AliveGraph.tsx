"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { clearGraphHeader, graphHeader } from "./graph-header";
import { attachAlive, trimEdge, trimSvg } from "./alive-engine";
import styles from "./AliveGraph.module.css";

export type AliveEvent = {
  kind: "recall" | "save" | "connect" | "work";
  on?: boolean;
  amber?: boolean;
  from?: number;
  of?: number;
  clear?: string;
  toward?: string;
};
type GraphController = ReturnType<typeof attachAlive>;
const graphs = new Map<string, GraphController>();

export function fireAlive(id: string, event: AliveEvent) {
  graphs.get(id)?.fire(event);
}

/** The supplied graph and engine share each mounted surface's lifetime. */
export function useAliveGraph(
  id: string,
  state: "live" | "still" | "cut",
  graph: string,
  event?: AliveEvent
) {
  const svg = useRef<SVGSVGElement>(null);
  const work = useRef(event);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    trimSvg(element);
    if (state !== "live") return;
    let engine: GraphController;
    const attach = () => {
      engine?.destroy();
      const tokens = getComputedStyle(element);
      element.dataset.ink = tokens.getPropertyValue("--fg-primary").trim();
      element.dataset.amber = tokens.getPropertyValue("--exo-amber").trim();
      element.dataset.phosphor = tokens.getPropertyValue("--exo-phosphor").trim();
      engine = attachAlive(element);
      graphs.set(id, engine);
      if (work.current?.kind === "work") engine.fire(work.current);
    };
    attach();
    const theme = new MutationObserver(attach);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduced.addEventListener("change", attach);
    return () => {
      theme.disconnect();
      reduced.removeEventListener("change", attach);
      if (graphs.get(id) === engine) graphs.delete(id);
      engine.destroy();
    };
  }, [id, state, graph, svg]);
  useEffect(() => {
    work.current = event;
    if (event && state === "live") fireAlive(id, event);
  }, [id, event, state, graph]);
  return svg;
}

export function AliveGraph({
  nodes: suppliedNodes,
  edges: suppliedEdges,
  viewBox,
  state = "live",
  hover = true,
  walk = false,
  entry,
  id,
  className,
  style,
  children,
  event,
  clearHeader = false,
}: {
  nodes: readonly (readonly [number, number, number?])[];
  edges: readonly (readonly [number, number])[];
  viewBox: string;
  state?: "live" | "still" | "cut";
  hover?: boolean;
  /** An ink light walks the web while nothing happens (Home's band). */
  walk?: boolean;
  entry?: string;
  id: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  event?: AliveEvent;
  clearHeader?: boolean;
}) {
  const [adjusted, setAdjusted] = useState<{
    nodes: readonly (readonly [number, number, number?])[];
    edges: readonly (readonly [number, number])[];
  } | null>(null);
  const nodes = clearHeader && adjusted ? adjusted.nodes : suppliedNodes;
  const edges = clearHeader && adjusted ? adjusted.edges : suppliedEdges;
  const graph = JSON.stringify({ n: nodes, e: edges });
  const svg = useAliveGraph(id, state, graph, event);
  useLayoutEffect(() => {
    const element = svg.current;
    if (!clearHeader || !element) return;
    const measure = () => {
      const box = element.viewBox.baseVal;
      const points = suppliedNodes.map(([x, y, r]) => ({ x, y, r: r ?? 3 }));
      const links = clearGraphHeader(
        points,
        suppliedEdges,
        graphHeader(element, box.width, box.height)
      );
      const next = {
        nodes: points.map((point) => [point.x, point.y, point.r] as const),
        edges: links,
      };
      setAdjusted((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element
      .closest("[data-alive-surface]")
      ?.querySelectorAll("[data-graph-clear]")
      .forEach((control) => observer.observe(control));
    document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, [clearHeader, suppliedNodes, suppliedEdges, svg]);
  return (
    <svg
      ref={svg}
      className={[styles.graph, styles[state], className].filter(Boolean).join(" ")}
      style={style}
      viewBox={viewBox}
      aria-hidden
      data-alive={state === "live" ? "loop" : "off"}
      data-graph={graph}
      data-alive-key={id}
      data-walk={walk ? "ink" : undefined}
      data-hover={hover && state === "live" ? "glow" : undefined}
      data-entry={entry}
    >
      {edges.map(([i, j], k) => {
        if (!nodes[i] || !nodes[j]) return null;
        const [a, b] = trimEdge(
          { x: nodes[i][0], y: nodes[i][1], r: nodes[i][2] },
          { x: nodes[j][0], y: nodes[j][1], r: nodes[j][2] }
        );
        return (
          <line
            key={`e${k}`}
            className={styles.edge}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            data-exo-t=""
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {nodes.map(([x, y, r], k) => (
        <circle key={`n${k}`} data-graph-node className={styles.node} cx={x} cy={y} r={r ?? 3} />
      ))}
      {children}
    </svg>
  );
}
