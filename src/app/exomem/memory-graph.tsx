"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The signature hero panel: a live "memory vault" that runs a 10s loop —
 * a query types in, a timer counts to a measured 864 ms, a stale note is
 * struck through and forwarded (supersession arrow) to the note that replaced
 * it, and the results settle in. Self-contained: SVG + requestAnimationFrame.
 *
 * SSR-safe and graceful: renders the lit end-state on the server and under
 * prefers-reduced-motion, so there's a coherent static image with no JS.
 *
 * Amber (#ffb000) appears ONLY on live / retrieved / current state.
 */

const MONO = "var(--font-mono-exo)";
const AMBER = "#ffb000";
const CYCLE = 10000;
const QUERY = 'kb find "stale decision"';

// Timeline — ms within the cycle.
const T = {
  typeStart: 500,
  typeEnd: 1880,
  searchEnd: 2820,
  nodeOld: 2150,
  arrowStart: 2400,
  arrowEnd: 3050,
  nodeNew: 2820,
  nodeEvid: 3120,
  resIn: 3250,
  fadeStart: 9300,
};

type Kind = "note" | "entity";
type Node = {
  id: string;
  x: number;
  y: number;
  label: string;
  kind?: Kind;
  ly: number;
};

const NODES: Node[] = [
  { id: "mcp", x: 72, y: 152, label: "mcp", kind: "entity", ly: -14 },
  { id: "gpu", x: 168, y: 66, label: "decisions/gpu-batching.md", ly: -14 },
  { id: "embed", x: 330, y: 50, label: "research/embedding-models.md", ly: -14 },
  { id: "fts5", x: 492, y: 88, label: "insights/fts5-latency.md", ly: -14 },
  { id: "oldplan", x: 200, y: 212, label: "notes/old-plan.md", ly: 22 },
  { id: "newer", x: 420, y: 180, label: "notes/newer-constraint.md", ly: -16 },
  { id: "sqlv", x: 552, y: 240, label: "sqlite-vec", kind: "entity", ly: 22 },
  { id: "bench", x: 318, y: 298, label: "sources/benchmark-run-014.md", ly: 24 },
  { id: "vault", x: 112, y: 322, label: "decisions/vault-layout.md", ly: 24 },
  { id: "review", x: 484, y: 348, label: "insights/review-queue.md", ly: 24 },
  { id: "meeting", x: 196, y: 402, label: "sources/meeting-2026-05-12.md", ly: 24 },
  { id: "clip", x: 396, y: 416, label: "research/clip-indexing.md", ly: 24 },
];

const EDGES: [string, string][] = [
  ["mcp", "gpu"], ["mcp", "oldplan"], ["gpu", "embed"], ["embed", "fts5"],
  ["embed", "newer"], ["gpu", "oldplan"], ["oldplan", "bench"], ["newer", "bench"],
  ["newer", "sqlv"], ["fts5", "sqlv"], ["bench", "vault"], ["vault", "meeting"],
  ["review", "newer"], ["review", "clip"], ["meeting", "clip"], ["vault", "mcp"],
];

const BY_ID: Record<string, Node> = Object.fromEntries(
  NODES.map((n) => [n.id, n]),
);

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOutExpo = (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));

/** Linear interpolation between two #rrggbb hexes → rgb() string. */
function mix(p: number, from: string, to: string): string {
  const f = parseInt(from.slice(1), 16);
  const t = parseInt(to.slice(1), 16);
  const r = Math.round(((f >> 16) & 255) + p * (((t >> 16) & 255) - ((f >> 16) & 255)));
  const g = Math.round(((f >> 8) & 255) + p * (((t >> 8) & 255) - ((f >> 8) & 255)));
  const b = Math.round((f & 255) + p * ((t & 255) - (f & 255)));
  return `rgb(${r},${g},${b})`;
}

type Anim = {
  typed: string;
  cursor: number;
  status: string;
  litOld: number;
  arrow: number;
  arrowFade: number;
  litNew: number;
  litEvid: number;
  res: number;
  final: boolean;
};

function derive(t: number): Anim {
  // Static/lit end-state: SSR, reduced motion, pre-mount.
  if (t < 0) {
    return {
      typed: QUERY,
      cursor: 0,
      status: "864 ms · 50,000 notes",
      litOld: 1,
      arrow: 1,
      arrowFade: 1,
      litNew: 1,
      litEvid: 1,
      res: 1,
      final: true,
    };
  }
  const fade = t > T.fadeStart ? 1 - clamp01((t - T.fadeStart) / 650) : 1;
  const nType = clamp01((t - T.typeStart) / (T.typeEnd - T.typeStart));
  const typed = QUERY.slice(0, Math.round(nType * QUERY.length));
  const searching = t >= T.typeEnd && t < T.searchEnd;

  let status = "";
  if (searching) {
    const p = clamp01((t - T.typeEnd) / (T.searchEnd - T.typeEnd));
    status = `${Math.round(864 * easeOutExpo(p))} ms`;
  } else if (t >= T.searchEnd && fade > 0.05) {
    status = "864 ms · 50,000 notes";
  }

  return {
    typed,
    cursor: fade,
    status,
    litOld: clamp01((t - T.nodeOld) / 300) * fade,
    arrow:
      easeOutExpo(clamp01((t - T.arrowStart) / (T.arrowEnd - T.arrowStart))) *
      (fade > 0 ? 1 : 0),
    arrowFade: fade,
    litNew: clamp01((t - T.nodeNew) / 300) * fade,
    litEvid: clamp01((t - T.nodeEvid) / 300) * fade,
    res: clamp01((t - T.resIn) / 450) * fade,
    final: false,
  };
}

function Graph({ a }: { a: Anim }) {
  const litEdges: Record<string, number> = {
    "oldplan|bench": a.litOld,
    "newer|bench": a.litNew,
  };

  return (
    <svg
      viewBox="0 0 620 460"
      style={{ width: "100%", height: "auto", display: "block" }}
      aria-hidden="true"
    >
      <defs>
        <filter id="exoGlow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation={6} />
        </filter>
        <marker
          id="exoArrow"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={7}
          markerHeight={7}
          orient="auto-start-reverse"
        >
          <path
            d="M 0 1 L 9 5 L 0 9"
            fill="none"
            stroke={AMBER}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>

      {EDGES.map(([f, to], i) => {
        const A = BY_ID[f];
        const B = BY_ID[to];
        const lit = litEdges[`${f}|${to}`] ?? litEdges[`${to}|${f}`] ?? 0;
        return (
          <line
            key={`e${i}`}
            x1={A.x}
            y1={A.y}
            x2={B.x}
            y2={B.y}
            stroke={
              lit > 0
                ? `rgba(255,176,0,${0.08 + 0.42 * lit})`
                : "rgba(236,233,226,0.09)"
            }
            strokeWidth={lit > 0 ? 1.2 : 1}
          />
        );
      })}

      {a.arrow > 0.01 && (
        <>
          <path
            d="M 212 202 C 266 158, 336 180, 406 180"
            fill="none"
            stroke={AMBER}
            strokeWidth={1.4}
            pathLength={1}
            style={{ strokeDasharray: 1, strokeDashoffset: 1 - a.arrow }}
            markerEnd="url(#exoArrow)"
            opacity={0.9 * (a.final ? 1 : a.arrowFade)}
          />
          <text
            x={292}
            y={150}
            textAnchor="middle"
            fontFamily={MONO}
            fontSize={9}
            letterSpacing="0.08em"
            fill={AMBER}
            opacity={0.75 * a.arrow * (a.final ? 1 : a.arrowFade)}
          >
            superseded-by
          </text>
        </>
      )}

      {NODES.map((n) => {
        const isOld = n.id === "oldplan";
        const isNew = n.id === "newer";
        const isEvid = n.id === "bench";
        const lit = isOld ? a.litOld : isNew ? a.litNew : isEvid ? a.litEvid : 0;
        const struck = isOld && lit > 0.4;
        const labelColor = struck
          ? "#6b655a"
          : isNew && lit > 0.4
            ? "#ffcf66"
            : lit > 0.3
              ? "#c8c3b8"
              : "#79746a";

        return (
          <g key={n.id}>
            {(isNew || isEvid) && lit > 0.01 && (
              <circle
                cx={n.x}
                cy={n.y}
                r={isNew ? 13 : 10}
                fill={AMBER}
                opacity={(isNew ? 0.4 : 0.22) * lit}
                filter="url(#exoGlow)"
              />
            )}
            {n.kind === "entity" ? (
              <rect
                x={n.x - 4.5}
                y={n.y - 4.5}
                width={9}
                height={9}
                fill="#221f1a"
                stroke="rgba(236,233,226,0.3)"
                strokeWidth={1}
              />
            ) : (
              <circle
                cx={n.x}
                cy={n.y}
                r={isNew ? 6 : 5}
                fill={
                  isNew
                    ? mix(lit, "#2a2620", "#ffb000")
                    : isEvid
                      ? mix(lit * 0.55, "#2a2620", "#ffb000")
                      : "#2a2620"
                }
                stroke={
                  isOld && lit > 0.01
                    ? `rgba(255,176,0,${0.45 * lit})`
                    : `rgba(236,233,226,${0.22 + 0.3 * lit})`
                }
                strokeWidth={1}
                strokeDasharray={isOld && lit > 0.01 ? "2.5 2.5" : undefined}
              />
            )}
            <text
              x={n.x}
              y={n.y + n.ly}
              textAnchor="middle"
              fontFamily={MONO}
              fontSize={n.kind === "entity" ? 9.5 : 10.5}
              letterSpacing={n.kind === "entity" ? "0.1em" : "0"}
              fill={labelColor}
              textDecoration={struck ? "line-through" : undefined}
            >
              {n.kind === "entity" ? n.label.toUpperCase() : n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function MemoryGraph() {
  const [t, setT] = useState<number>(-1);
  const start = useRef(0);
  const last = useRef(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) {
      setT(-2); // hold the lit end-state
      return;
    }
    start.current = performance.now();
    last.current = 0;
    const tick = (now: number) => {
      if (now - last.current > 40) {
        last.current = now;
        setT((now - start.current) % CYCLE);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  const a = derive(t);
  const showCursor = a.cursor > 0.05 && !a.final;

  return (
    <div
      data-reveal
      data-reveal-delay="250"
      role="img"
      aria-label="Live diagram of an Exomem memory vault: notes connected by wikilinks. A query retrieves a stale note, shown struck through and forwarded to the note that superseded it, in 864 milliseconds."
      style={{
        position: "relative",
        border: "1px solid var(--exo-border-card)",
        borderRadius: "12px",
        background: "var(--bg-panel)",
        boxShadow:
          "0 0 0 1px rgba(0,0,0,0.4), 0 24px 80px rgba(0,0,0,0.45), 0 0 120px rgba(255,176,0,0.04)",
        overflow: "hidden",
      }}
    >
      {/* Scanline overlay — CRT-phosphor texture, non-interactive. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 3,
          background:
            "repeating-linear-gradient(0deg, rgba(255,220,160,0.028) 0px, rgba(255,220,160,0.028) 1px, transparent 1px, transparent 3px)",
        }}
      />

      {/* Header: typed query + cursor · status */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "12px",
          padding: "14px 18px",
          borderBottom: "1px solid var(--exo-rule)",
          fontFamily: MONO,
          fontSize: "12.5px",
        }}
      >
        <div
          style={{
            color: "var(--fg-secondary)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span style={{ color: "var(--fg-tertiary)" }}>$ </span>
          {a.typed}
          {showCursor ? (
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: "7px",
                height: "14px",
                background: AMBER,
                verticalAlign: "-2px",
                marginLeft: "1px",
                animation: "exoBlink 1.1s steps(1) infinite",
              }}
            />
          ) : a.final ? (
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: "7px",
                height: "14px",
                background: AMBER,
                verticalAlign: "-2px",
                marginLeft: "1px",
                opacity: 0.7,
              }}
            />
          ) : null}
        </div>
        <div style={{ color: AMBER, fontSize: "11.5px", whiteSpace: "nowrap" }}>
          {a.status}
        </div>
      </div>

      {/* Graph over a dot grid */}
      <div
        style={{
          backgroundImage:
            "radial-gradient(rgba(236,233,226,0.05) 1px, transparent 1px)",
          backgroundSize: "22px 22px",
          padding: "4px 2px 0",
        }}
      >
        <Graph a={a} />
      </div>

      {/* Results */}
      <div
        style={{
          opacity: a.res,
          transform: a.res < 1 ? `translateY(${6 * (1 - a.res)}px)` : "none",
        }}
      >
        <div
          style={{
            padding: "12px 18px 4px",
            fontFamily: MONO,
            fontSize: "12px",
            borderTop: "1px solid var(--exo-rule)",
          }}
        >
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              gap: "2px 12px",
              padding: "3px 0",
            }}
          >
            <span style={{ color: "var(--fg-primary)" }}>
              → notes/newer-constraint.md
            </span>
            <span style={{ color: AMBER }}>current</span>
          </div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "space-between",
              gap: "2px 12px",
              padding: "3px 0",
            }}
          >
            <span
              style={{
                color: "var(--fg-dim-struck)",
                textDecoration: "line-through",
              }}
            >
              → notes/old-plan.md
            </span>
            <span style={{ color: "var(--fg-tertiary)" }}>
              superseded · forwarded
            </span>
          </div>
          <div
            style={{
              padding: "8px 0 10px",
              color: "var(--fg-tertiary)",
              fontSize: "11px",
            }}
          >
            2 results · 864 ms end-to-end · 50,000 notes · cache cold
          </div>
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "8px 18px",
          padding: "10px 18px 14px",
          borderTop: "1px solid var(--exo-rule)",
          fontFamily: MONO,
          fontSize: "10.5px",
          color: "var(--fg-tertiary)",
        }}
      >
        <span>
          <span style={{ color: AMBER }}>●</span> retrieved
        </span>
        <span>
          <span style={{ textDecoration: "line-through" }}>struck</span>{" "}
          superseded
        </span>
        <span>○ note</span>
        <span>▪ entity</span>
      </div>
    </div>
  );
}
