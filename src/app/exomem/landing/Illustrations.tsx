"use client";

import { useEffect, type CSSProperties } from "react";
import { fireAlive, useAliveGraph } from "@/components/exomem/AliveGraph";
import responsive from "./responsive.module.css";
import styles from "./illustrations.module.css";

// These coordinates are the approved landing illustrations, not account or vault data.
// Each drawing is the board's (Landing-Page): amber marks what is current and a light runs
// along it (the "A + loop" direction, R41); everything else is ink.
const AMBER = "var(--exo-amber)";

/** The board's running light (`.pt`): a short amber dash travels the link from a to b. */
function Pulse({
  from: [x1, y1],
  to: [x2, y2],
  width,
  delay,
}: {
  from: readonly [number, number];
  to: readonly [number, number];
  width: number;
  delay: number;
}) {
  return (
    <line
      className={styles.pulse}
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={AMBER}
      strokeWidth={width}
      strokeLinecap="round"
      style={
        { "--len": Math.hypot(x2 - x1, y2 - y1).toFixed(1), "--dl": `${delay}s` } as CSSProperties
      }
    />
  );
}

// The board's engine graph: the note, its four links, then the four sources the pointer lights.
const REMEMBER_GRAPH = JSON.stringify({
  n: [
    [138, 60, 6],
    [190, 26, 2.6],
    [204, 70, 2.6],
    [176, 100, 2.6],
    [222, 40, 2.6],
    [22, 18, 3],
    [22, 46, 3],
    [22, 74, 3],
    [22, 102, 3],
  ],
  e: [
    [0, 1],
    [0, 2],
    [0, 3],
    [0, 4],
  ],
});
const REMEMBER_LINKS = [
  [190, 26],
  [204, 70],
  [176, 100],
  [222, 40],
] as const;

/** Each source square's top edge, and its line to the note, drawn between the two edges. */
const REMEMBER_SOURCES = [
  { y: 11, line: [30.46, 21.06, 132.36, 57.96] },
  { y: 39, line: [30.94, 47.08, 132.04, 59.28] },
  { y: 67, line: [30.94, 72.92, 132.04, 60.72] },
  { y: 95, line: [30.46, 98.94, 132.36, 62.04] },
] as const;

/** Four sources feed one note, which links on; the source being kept runs in amber. */
export function RememberDrawing() {
  const svg = useAliveGraph("landing-remember", "live", REMEMBER_GRAPH);
  return (
    <svg
      ref={svg}
      viewBox="0 0 250 120"
      className={styles.pillar}
      aria-hidden
      data-alive="loop"
      data-graph={REMEMBER_GRAPH}
      data-hover="glow"
    >
      {REMEMBER_SOURCES.map(({ y, line: [x1, y1, x2, y2] }) => (
        <g key={y}>
          <rect
            x="15"
            y={y}
            width="14"
            height="14"
            rx="4"
            fill="var(--bg-hover)"
            stroke="rgba(var(--ink-rgb), .18)"
          />
          <line
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={AMBER}
            strokeOpacity={y === 39 ? 0.75 : 0.18}
            strokeWidth={y === 39 ? 1.6 : 1}
          />
        </g>
      ))}
      <Pulse from={[31, 46]} to={[132, 60]} width={1.8} delay={0} />
      <circle className={styles.swell} cx="138" cy="60" r="10" fill={AMBER} opacity=".18" />
      <circle data-graph-node cx="138" cy="60" r="5" fill={AMBER} />
      {REMEMBER_LINKS.map(([x, y]) => (
        <g key={`${x},${y}`}>
          <circle data-graph-node cx={x} cy={y} r="2.6" className={styles.node} />
          <line x1="138" y1="60" x2={x} y2={y} stroke="var(--fg-primary)" strokeOpacity=".12" />
        </g>
      ))}
    </svg>
  );
}

const CONNECT_GRAPH = JSON.stringify({
  n: [
    [40, 60, 4],
    [120, 30, 4.5],
    [120, 92, 3.6],
    [200, 58, 3.6],
  ],
  e: [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
  ],
});

/** One note supports another, in amber, and contradicts a third. */
export function ConnectDrawing() {
  const svg = useAliveGraph("landing-connect", "live", CONNECT_GRAPH);
  return (
    <svg
      ref={svg}
      viewBox="0 0 250 120"
      className={styles.pillar}
      aria-hidden
      data-alive="loop"
      data-graph={CONNECT_GRAPH}
      data-hover="glow"
    >
      <line x1="40" y1="60" x2="120" y2="30" stroke={AMBER} strokeWidth="2" />
      <line
        className={styles.march}
        x1="40"
        y1="60"
        x2="120"
        y2="92"
        stroke="var(--fg-primary)"
        strokeOpacity=".55"
        strokeDasharray="5 4"
      />
      <Pulse from={[40, 60]} to={[120, 30]} width={1.8} delay={1.2} />
      <Pulse from={[120, 30]} to={[200, 58]} width={1.4} delay={3.8} />
      <line x1="120" y1="30" x2="200" y2="58" stroke={AMBER} strokeDasharray="1.5 3.5" />
      <line x1="120" y1="92" x2="200" y2="58" stroke="var(--fg-primary)" strokeOpacity=".2" />
      <circle data-graph-node cx="40" cy="60" r="4" fill="var(--fg-primary)" />
      <circle data-graph-node cx="120" cy="30" r="4.5" fill={AMBER} />
      <circle data-graph-node cx="120" cy="92" r="3.6" fill="var(--fg-primary)" />
      <circle data-graph-node cx="200" cy="58" r="3.6" fill="var(--fg-primary)" />
      <text className={`${styles.svgText} ${styles.current}`} x="58" y="34" fontSize="9">
        supports
      </text>
      <text className={styles.svgText} x="52" y="96" fontSize="9">
        contradicts
      </text>
    </svg>
  );
}

/** The old plan stays on the timeline after a newer note, in amber, replaces it. */
export function EvolveDrawing() {
  // The board's graph: only the old plan is a note the pointer lights.
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
      <circle
        data-graph-node
        cx="60"
        cy="48"
        r="5"
        fill="var(--bg-base)"
        stroke="var(--fg-muted)"
        strokeWidth="1.4"
      />
      <text className={styles.svgText} x="44" y="30" fontSize="9" textDecoration="line-through">
        old-plan
      </text>
      <path d="M 68 46 Q 115 22 162 44" fill="none" stroke={AMBER} strokeWidth="1.5" />
      <path d="M 154 39 L 163 45 L 153 48" fill="none" stroke={AMBER} strokeWidth="1.5" />
      <path
        className={styles.pulse}
        d="M 68 46 Q 115 22 162 44"
        fill="none"
        stroke={AMBER}
        strokeWidth="1.8"
        strokeLinecap="round"
        style={{ "--len": 104, "--dl": "2.4s" } as CSSProperties}
      />
      <circle
        className={styles.swell}
        cx="170"
        cy="48"
        r="9"
        fill={AMBER}
        opacity=".18"
        style={{ "--dl": "2.4s" } as CSSProperties}
      />
      <circle cx="170" cy="48" r="5" fill={AMBER} />
      <text className={`${styles.svgText} ${styles.current}`} x="150" y="70" fontSize="9">
        newer
      </text>
      <rect x="196" y="85" width="34" height="6" rx="3" fill={AMBER} />
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
// The board's spoke styles: amber for the links that hold, ink for a contradiction or a
// loose relation. Each spoke but a contradiction or a superseded note carries a running light.
const SPOKE_LINE = {
  supports: { stroke: AMBER, strokeWidth: 1.8 },
  refines: { stroke: AMBER, strokeDasharray: "1.5 3.5" },
  superseded: { stroke: AMBER },
  contradicts: { stroke: "var(--fg-primary)", strokeOpacity: 0.6, strokeDasharray: "5 4" },
  relates: { stroke: "var(--fg-primary)", strokeOpacity: 0.3 },
} as const;
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
  // A hidden tab skips its recalls: the engine would replay them all at once on return.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) fireAlive(id, { kind: "recall" });
    }, 6500);
    return () => window.clearInterval(timer);
  }, [id]);
  return (
    <svg
      ref={svg}
      viewBox={viewBox}
      className={`${styles.map} ${className}`}
      aria-hidden
      data-hover="glow"
      data-lit="0"
      data-alive="loop"
      data-graph={graph}
    >
      {FIELD.map(([x, y]) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r="2" className={styles.fieldNode} />
      ))}
      {SPOKES.map(([x, y, kind], i) => (
        <g key={`${x},${y}`}>
          <line x1="360" y1="150" x2={x} y2={y} {...SPOKE_LINE[kind]} />
          {kind === "contradicts" || kind === "superseded" ? null : (
            <Pulse from={[360, 150]} to={[x, y]} width={1.7} delay={i * 1.6} />
          )}
          <circle
            data-graph-node
            cx={x}
            cy={y}
            r="3.6"
            fill={kind === "superseded" ? "var(--bg-base)" : "var(--fg-primary)"}
            stroke={kind === "superseded" ? "var(--fg-muted)" : undefined}
            strokeWidth={kind === "superseded" ? 1.3 : undefined}
          />
        </g>
      ))}
      <circle className={styles.breath} cx="360" cy="150" r="12" fill={AMBER} opacity=".2" />
      <circle data-graph-node cx="360" cy="150" r="6" fill={AMBER} />
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
