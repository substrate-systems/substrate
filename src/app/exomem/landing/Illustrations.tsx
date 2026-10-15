"use client";

import { useEffect } from "react";
import { AliveGraph, fireAlive, useAliveGraph } from "@/components/exomem/AliveGraph";
import responsive from "./responsive.module.css";
import styles from "./illustrations.module.css";

// These coordinates are the approved landing illustrations, not account or vault data.
// The engine's graph is the board's: the four sources are notes the pointer can light, and
// the ambient pulses run only along the note's own links.
const REMEMBER_NODES = [
  [22, 18, 3],
  [22, 46, 3],
  [22, 74, 3],
  [22, 102, 3],
  [138, 60, 5],
  [190, 26, 2.6],
  [204, 70, 2.6],
  [176, 100, 2.6],
  [222, 40, 2.6],
] as const;
const REMEMBER_EDGES = [
  [4, 5],
  [4, 6],
  [4, 7],
  [4, 8],
] as const;
const CONNECT_NODES = [
  [40, 60, 4],
  [120, 30, 4.5],
  [120, 92, 3.6],
  [200, 58, 3.6],
] as const;
const CONNECT_EDGES = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
] as const;

/** Four sources feed one note, which links on. Ambient motion stays in ink. */
export function RememberDrawing() {
  const graph = JSON.stringify({ n: REMEMBER_NODES, e: REMEMBER_EDGES });
  const svg = useAliveGraph("landing-remember", "live", graph);
  return (
    <svg
      ref={svg}
      viewBox="0 0 250 120"
      className={styles.pillar}
      aria-hidden
      data-alive="loop"
      data-graph={graph}
      data-hover="glow"
    >
      {[11, 39, 67, 95].map((y) => (
        <g key={y}>
          <line
            x1="31"
            y1={y + 7}
            x2="138"
            y2="60"
            stroke="var(--fg-primary)"
            strokeOpacity=".18"
          />
          <rect
            x="15"
            y={y}
            width="14"
            height="14"
            rx="4"
            fill="var(--bg-hover)"
            stroke="rgba(var(--ink-rgb), .18)"
          />
        </g>
      ))}
      {REMEMBER_EDGES.map(([i, j]) => (
        <line
          key={j}
          x1={REMEMBER_NODES[i][0]}
          y1={REMEMBER_NODES[i][1]}
          x2={REMEMBER_NODES[j][0]}
          y2={REMEMBER_NODES[j][1]}
          stroke="var(--fg-primary)"
          strokeOpacity=".12"
        />
      ))}
      {REMEMBER_NODES.slice(4).map(([x, y, r]) => (
        <circle key={`${x},${y}`} data-graph-node cx={x} cy={y} r={r} className={styles.node} />
      ))}
    </svg>
  );
}

/** One note supports another and contradicts a third. */
export function ConnectDrawing() {
  return (
    <AliveGraph
      id="landing-connect"
      nodes={CONNECT_NODES}
      edges={CONNECT_EDGES}
      viewBox="0 0 250 120"
      className={`${styles.pillar} ${styles.connect}`}
    >
      <text className={styles.svgText} x="58" y="34" fontSize="9">
        supports
      </text>
      <text className={styles.svgText} x="52" y="96" fontSize="9">
        contradicts
      </text>
    </AliveGraph>
  );
}

/** The old plan stays on the timeline after a newer note replaces it. */
export function EvolveDrawing() {
  // The board's graph: only the old plan is a note the pointer lights; nothing travels here.
  const graph = JSON.stringify({ n: [[60, 48, 5]], e: [] });
  const svg = useAliveGraph("landing-evolve", "live", graph);
  return (
    <svg
      ref={svg}
      viewBox="0 0 250 120"
      className={styles.pillar}
      aria-hidden
      data-alive="loop"
      data-graph={graph}
      data-hover="glow"
    >
      <line x1="20" y1="88" x2="230" y2="88" stroke="var(--bg-track)" strokeWidth="3" />
      {[30, 80, 130, 180, 220].map((x) => (
        <line key={x} x1={x} y1="84" x2={x} y2="92" stroke="var(--fg-tertiary)" />
      ))}
      <path d="M 68 46 Q 115 22 162 44" fill="none" stroke="var(--fg-primary)" strokeWidth="1.5" />
      <path
        d="M 154 39 L 163 45 L 153 48"
        fill="none"
        stroke="var(--fg-primary)"
        strokeWidth="1.5"
      />
      <circle
        data-graph-node
        cx="60"
        cy="48"
        r="5"
        fill="var(--bg-base)"
        stroke="var(--fg-muted)"
        strokeWidth="1.4"
      />
      <circle data-graph-node cx="170" cy="48" r="5" className={styles.node} />
      <text className={styles.svgText} x="44" y="30" fontSize="9" textDecoration="line-through">
        old-plan
      </text>
      <text className={styles.svgText} x="150" y="70" fontSize="9">
        newer
      </text>
      <rect x="196" y="85" width="34" height="6" rx="3" fill="var(--fg-primary)" />
    </svg>
  );
}

// The supplied map's hub and typed spokes. Relation styles are a fixed illustration contract.
const SPOKES = [
  [419, 58, "supports"],
  [455.5, 87.6, "refines"],
  [475.4, 127.9, "supports"],
  [475.4, 172.1, "contradicts"],
  [455.5, 212.4, "superseded"],
  [419, 242, "relates"],
  [301, 242, "supports"],
  [257.8, 203.1, "refines"],
  [242, 150, "contradicts"],
  [257.8, 96.9, "relates"],
  [301, 58, "supports"],
] as const;
const MAP_NODES = [[360, 150, 6], ...SPOKES.map(([x, y]) => [x, y, 3.6] as const)] as const;
const MAP_EDGES = SPOKES.map((_, i) => [0, i + 1] as const);
const FIELD = Array.from({ length: 70 }, (_, i) => [40 + ((53 * i) % 680), 20 + ((37 * i) % 260)]);

function MapDrawing({
  viewBox,
  className,
  id,
}: {
  viewBox: string;
  className: string;
  id: string;
}) {
  const graph = JSON.stringify({ n: MAP_NODES, e: MAP_EDGES });
  const svg = useAliveGraph(id, "live", graph);
  // Every few seconds the map recalls a note and what it links to (the board's 6.5 s).
  useEffect(() => {
    const timer = window.setInterval(() => fireAlive(id, { kind: "recall" }), 6500);
    return () => window.clearInterval(timer);
  }, [id]);
  return (
    <svg
      ref={svg}
      viewBox={viewBox}
      className={`${styles.map} ${className}`}
      aria-hidden
      data-alive="loop"
      data-graph={graph}
    >
      {FIELD.map(([x, y]) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r="2" className={styles.fieldNode} />
      ))}
      {SPOKES.map(([x, y, kind]) => (
        <line
          key={`${x},${y}`}
          x1="360"
          y1="150"
          x2={x}
          y2={y}
          stroke="var(--fg-primary)"
          strokeOpacity={kind === "contradicts" ? 0.6 : 0.3}
          strokeDasharray={
            kind === "contradicts" ? "5 4" : kind === "refines" ? "1.5 3.5" : undefined
          }
        />
      ))}
      <circle data-graph-node cx="360" cy="150" r="6" className={styles.node} />
      {SPOKES.map(([x, y, kind]) => (
        <circle
          key={`${x},${y}`}
          data-graph-node
          cx={x}
          cy={y}
          r="3.6"
          className={kind === "superseded" ? undefined : styles.node}
          fill={kind === "superseded" ? "var(--bg-base)" : undefined}
          stroke={kind === "superseded" ? "var(--fg-muted)" : undefined}
          strokeWidth={kind === "superseded" ? 1.3 : undefined}
        />
      ))}
    </svg>
  );
}

/** The phone crops the same living map to its hub. */
export function LivingMap() {
  return (
    <>
      <MapDrawing id="landing-map-desktop" viewBox="0 0 720 300" className={responsive.deskOnly} />
      <MapDrawing
        id="landing-map-phone"
        viewBox="200 20 320 260"
        className={responsive.phoneOnly}
      />
    </>
  );
}
