import type { CSSProperties } from "react";
import responsive from "./responsive.module.css";
import styles from "./illustrations.module.css";

// The board's drawings, coordinates as drawn (Landing-Page, "How it stays true" and
// "See it"). Each runner light carries its link's length (--len), its loop (--d) and its
// start (--dl); a pulse shares its link's loop.

const run = (len: number, d: number, dl: number) =>
  ({ "--len": len, "--d": `${d}s`, "--dl": `${dl}s` }) as CSSProperties;
const pulse = (d: number, dl: number) => ({ "--d": `${d}s`, "--dl": `${dl}s` }) as CSSProperties;

const AMBER = "var(--exo-amber)";
const INK = "var(--fg-primary)";
const MUTED = "var(--fg-muted)";
const AMBER_TEXT = "var(--exo-amber-text)";

/** 01 Remember: four sources feed one note, which links on. */
export function RememberDrawing() {
  const sources = [11, 39, 67, 95];
  const linked = [
    [190, 26],
    [204, 70],
    [176, 100],
    [222, 40],
  ];
  return (
    <svg
      viewBox="0 0 250 120"
      width="250"
      height="120"
      className={styles.pillar}
      aria-hidden="true"
    >
      {sources.map((y, i) => (
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
            x1="31"
            y1={y + 7}
            x2="132"
            y2="60"
            stroke={AMBER}
            strokeOpacity={i === 1 ? 0.75 : 0.18}
            strokeWidth={i === 1 ? 1.6 : 1}
          />
        </g>
      ))}
      <line
        className={styles.pt}
        x1="31"
        y1="46"
        x2="132"
        y2="60"
        stroke={AMBER}
        strokeWidth="1.8"
        strokeLinecap="round"
        style={run(102, 7, 0)}
      />
      <circle
        className={styles.pp}
        cx="138"
        cy="60"
        r="10"
        fill={AMBER}
        opacity=".18"
        style={pulse(7, 0)}
      />
      <circle cx="138" cy="60" r="5" fill={AMBER} />
      {linked.map(([x, y]) => (
        <g key={`${x},${y}`}>
          <circle cx={x} cy={y} r="2.6" fill={INK} opacity=".35" />
          <line x1="138" y1="60" x2={x} y2={y} stroke={INK} strokeOpacity=".12" />
        </g>
      ))}
    </svg>
  );
}

/** 02 Connect: one note supports another, and contradicts a third. */
export function ConnectDrawing() {
  return (
    <svg
      viewBox="0 0 250 120"
      width="250"
      height="120"
      className={styles.pillar}
      aria-hidden="true"
    >
      <line x1="40" y1="60" x2="120" y2="30" stroke={AMBER} strokeWidth="2" />
      <line
        className={styles.mz}
        x1="40"
        y1="60"
        x2="120"
        y2="92"
        stroke={INK}
        strokeOpacity=".55"
        strokeDasharray="5 4"
      />
      <line
        className={styles.pt}
        x1="40"
        y1="60"
        x2="120"
        y2="30"
        stroke={AMBER}
        strokeWidth="1.8"
        strokeLinecap="round"
        style={run(85.4, 7.5, 1.2)}
      />
      <line
        className={styles.pt}
        x1="120"
        y1="30"
        x2="200"
        y2="58"
        stroke={AMBER}
        strokeWidth="1.4"
        strokeLinecap="round"
        style={run(84.8, 7.5, 3.8)}
      />
      <line x1="120" y1="30" x2="200" y2="58" stroke={AMBER} strokeDasharray="1.5 3.5" />
      <line x1="120" y1="92" x2="200" y2="58" stroke={INK} strokeOpacity=".2" />
      <circle cx="40" cy="60" r="4" fill={INK} />
      <circle cx="120" cy="30" r="4.5" fill={AMBER} />
      <circle cx="120" cy="92" r="3.6" fill={INK} />
      <circle cx="200" cy="58" r="3.6" fill={INK} />
      <text className={styles.svgText} x="58" y="34" fontSize="9" fill={AMBER_TEXT}>
        supports
      </text>
      <text className={styles.svgText} x="52" y="96" fontSize="9" fill={MUTED}>
        contradicts
      </text>
    </svg>
  );
}

/** 03 Evolve: the old plan is superseded by a newer note, kept on the timeline. */
export function EvolveDrawing() {
  const ticks = [30, 80, 130, 180, 220];
  return (
    <svg
      viewBox="0 0 250 120"
      width="250"
      height="120"
      className={styles.pillar}
      aria-hidden="true"
    >
      <line x1="20" y1="88" x2="230" y2="88" stroke="var(--bg-track)" strokeWidth="3" />
      {ticks.map((x) => (
        <line key={x} x1={x} y1="84" x2={x} y2="92" stroke="var(--fg-tertiary)" />
      ))}
      <circle cx="60" cy="48" r="5" fill="var(--bg-base)" stroke={MUTED} strokeWidth="1.4" />
      <text
        className={styles.svgText}
        x="44"
        y="30"
        fontSize="9"
        fill={MUTED}
        textDecoration="line-through"
      >
        old-plan
      </text>
      <path d="M 68 46 Q 115 22 162 44" fill="none" stroke={AMBER} strokeWidth="1.5" />
      <path d="M 154 39 L 163 45 L 153 48" fill="none" stroke={AMBER} strokeWidth="1.5" />
      <path
        className={styles.pt}
        d="M 68 46 Q 115 22 162 44"
        fill="none"
        stroke={AMBER}
        strokeWidth="1.8"
        strokeLinecap="round"
        style={run(104, 8, 2.4)}
      />
      <circle
        className={styles.pp}
        cx="170"
        cy="48"
        r="9"
        fill={AMBER}
        opacity=".18"
        style={pulse(8, 2.4)}
      />
      <circle cx="170" cy="48" r="5" fill={AMBER} />
      <text className={styles.svgText} x="150" y="70" fontSize="9" fill={AMBER_TEXT}>
        newer
      </text>
      <rect x="196" y="85" width="34" height="6" rx="3" fill={AMBER} />
    </svg>
  );
}

// The living map: one hub and its eleven links, each typed. A light runs out along one
// link at a time on a 15 s loop.
type Spoke = {
  x: number;
  y: number;
  kind: "supports" | "refines" | "contradicts" | "superseded" | "relates";
  /** When the runner light leaves along this link, if it does. */
  run?: { len: number; dl: number };
};

const HUB = { x: 360, y: 150 };
const MAP_LOOP_S = 15;

const SPOKES: readonly Spoke[] = [
  { x: 419, y: 58, kind: "supports", run: { len: 109.3, dl: 0 } },
  { x: 455.5, y: 87.6, kind: "refines", run: { len: 114.1, dl: 1.6 } },
  { x: 475.4, y: 127.9, kind: "supports", run: { len: 117.5, dl: 3.2 } },
  { x: 475.4, y: 172.1, kind: "contradicts" },
  { x: 455.5, y: 212.4, kind: "superseded" },
  { x: 419, y: 242, kind: "relates", run: { len: 109.3, dl: 8 } },
  { x: 301, y: 242, kind: "supports", run: { len: 109.3, dl: 9.6 } },
  { x: 257.8, y: 203.1, kind: "refines", run: { len: 115.2, dl: 11.2 } },
  { x: 242, y: 150, kind: "contradicts" },
  { x: 257.8, y: 96.9, kind: "relates", run: { len: 115.2, dl: 14.4 } },
  { x: 301, y: 58, kind: "supports", run: { len: 109.3, dl: 16 } },
];

const SPOKE_LINE: Record<
  Spoke["kind"],
  { stroke: string; width?: number; opacity?: number; dash?: string }
> = {
  supports: { stroke: AMBER, width: 1.8 },
  refines: { stroke: AMBER, dash: "1.5 3.5" },
  contradicts: { stroke: INK, opacity: 0.6, dash: "5 4" },
  superseded: { stroke: AMBER },
  relates: { stroke: INK, opacity: 0.3 },
};

// The faint field behind the map: 70 points stepped across the frame (the board's spread).
const FIELD = Array.from({ length: 70 }, (_, i) => ({
  x: 40 + ((53 * i) % 680),
  y: 20 + ((37 * i) % 260),
}));

function MapDrawing({ viewBox, className }: { viewBox: string; className: string }) {
  return (
    <svg viewBox={viewBox} className={`${styles.map} ${className}`} aria-hidden="true">
      {FIELD.map(({ x, y }) => (
        <circle key={`${x},${y}`} cx={x} cy={y} r="2" fill={INK} opacity=".12" />
      ))}
      {SPOKES.map((spoke) => {
        const line = SPOKE_LINE[spoke.kind];
        return (
          <g key={`${spoke.x},${spoke.y}`}>
            <line
              x1={HUB.x}
              y1={HUB.y}
              x2={spoke.x}
              y2={spoke.y}
              stroke={line.stroke}
              strokeWidth={line.width}
              strokeOpacity={line.opacity}
              strokeDasharray={line.dash}
            />
            {spoke.run && (
              <line
                className={styles.pt}
                x1={HUB.x}
                y1={HUB.y}
                x2={spoke.x}
                y2={spoke.y}
                stroke={AMBER}
                strokeWidth="1.7"
                strokeLinecap="round"
                style={run(spoke.run.len, MAP_LOOP_S, spoke.run.dl)}
              />
            )}
            {spoke.kind === "superseded" ? (
              <circle
                cx={spoke.x}
                cy={spoke.y}
                r="3.6"
                fill="var(--bg-base)"
                stroke={MUTED}
                strokeWidth="1.3"
              />
            ) : (
              <circle cx={spoke.x} cy={spoke.y} r="3.6" fill={INK} />
            )}
          </g>
        );
      })}
      <circle className={styles.br} cx={HUB.x} cy={HUB.y} r="12" fill={AMBER} opacity=".2" />
      <circle cx={HUB.x} cy={HUB.y} r="6" fill={AMBER} />
    </svg>
  );
}

/**
 * The living map, 720 × 300 on desktop; on a phone the frame crops to the hub
 * (viewBox 200 20 320 260, R20-Mobile).
 */
export function LivingMap() {
  return (
    <>
      <MapDrawing viewBox="0 0 720 300" className={responsive.deskOnly} />
      <MapDrawing viewBox="200 20 320 260" className={responsive.phoneOnly} />
    </>
  );
}
