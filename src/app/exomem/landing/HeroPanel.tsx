"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ANSWER_NOTE,
  DESKTOP_LAYOUT,
  HERO_LINKS,
  HERO_NOTES,
  PHONE_LAYOUT,
  SUPERSEDED_NOTE,
  noteName,
  heroLabelOffset,
  type HeroLayout,
  type LinkKind,
} from "./hero-graph";
import responsive from "./responsive.module.css";
import styles from "./HeroPanel.module.css";
import { useAliveGraph } from "@/components/exomem/AliveGraph";

// Which notes each note links to, for the hover: its neighbours stay lit.
const NEIGHBOURS = HERO_NOTES.map(
  (_, note) =>
    new Set(
      HERO_LINKS.flatMap(({ from, to }) => (from === note ? [to] : to === note ? [from] : []))
    )
);

const LABEL_FILL = {
  ink: "var(--fg-primary)",
  muted: "var(--fg-muted)",
  amber: "var(--exo-amber-text)",
} as const;

// The recall's typed links: how each draws in, from the board's classes.
const LINK_MOTION: Record<Exclude<LinkKind, "relates" | "supersedes">, string> = {
  supports: `${styles.ld} ${styles.e1}`,
  contradicts: `${styles.lf} ${styles.e3}`,
  refines: `${styles.lf} ${styles.e2}`,
};

const ANSWER_MOTION = { 1: styles.n1, 2: styles.n2, 3: styles.n3 } as const;

type GraphProps = {
  layout: HeroLayout;
  /** Phone names notes without their folder. */
  shortNames: boolean;
  className: string;
  active: number | null;
  onActive: (note: number | null, tapped?: boolean) => void;
};

function HeroGraph({ layout, shortNames, className, active, onActive }: GraphProps) {
  const graph = JSON.stringify({
    n: layout.notes.map(({ x, y }) => [x, y, layout.noteRadius]),
    e: HERO_LINKS.map(({ from, to }) => [from, to]),
  });
  const svg = useAliveGraph(`hero-${layout.width}`, "live", graph);
  useLayoutEffect(() => {
    const element = svg.current;
    if (!element) return;
    const labels = [...element.querySelectorAll<SVGTextElement>("[data-note] > text")];
    labels.forEach((label) => label.removeAttribute("transform"));
    if (active === null || !layout.notes[active].label.onDemand) return;
    const selected = labels[active];
    const obstacles = labels.flatMap((label, index) =>
      layout.notes[index].label.onDemand ? [] : [label.getBBox()]
    );
    const offset = heroLabelOffset(layout, selected.getBBox(), obstacles, layout.labelHalo);
    selected.setAttribute("transform", `translate(${offset.x} ${offset.y})`);
  }, [active, layout, svg]);
  // Mouse: hover lights a note. With a finger or a pen, a tap names it; another tap on it, or a
  // tap anywhere else on the page (HeroPanel listens for that), puts it out.
  const pointer = useRef<string>("mouse");
  const ignoreMouseUntil = useRef(0);
  const at = (note: number) => layout.notes[note];
  const linkClass = (from: number, to: number, base: string) =>
    [styles.edge, base, active !== null && (from === active || to === active) && styles.isIncident]
      .filter(Boolean)
      .join(" ");

  const hover = (note: number | null) => (event: ReactPointerEvent) => {
    pointer.current = event.pointerType;
    if (event.pointerType === "mouse" && performance.now() >= ignoreMouseUntil.current)
      onActive(note);
  };

  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className={`${styles.graph} ${className}`}
      // Scales down with the panel, never past the size it is drawn at.
      style={{ maxWidth: layout.width }}
      aria-hidden="true"
      data-active={active !== null || undefined}
      data-alive="loop"
      data-graph={graph}
      data-walk="ink"
      onPointerDown={(event) => (pointer.current = event.pointerType)}
    >
      <defs>
        <pattern
          id={`hero-grid-${layout.width}`}
          x={layout.gridStart - 11}
          y={layout.gridStart - 11}
          width="22"
          height="22"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="11" cy="11" r=".7" fill="var(--fg-primary)" opacity=".07" />
        </pattern>
      </defs>
      <rect width={layout.width} height={layout.height} fill={`url(#hero-grid-${layout.width})`} />

      {HERO_LINKS.map(({ from, to, kind }) => {
        const a = at(from);
        const b = at(to);
        const key = `${from}-${to}`;
        if (kind === "relates") {
          return (
            <line
              key={key}
              className={linkClass(from, to, styles.plain)}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="var(--fg-primary)"
              strokeOpacity=".22"
              strokeWidth="1.15"
            />
          );
        }
        if (kind === "supersedes") {
          const { d, length, arrow, label } = layout.supersedes;
          return (
            <g key={key}>
              <path
                className={linkClass(from, to, `${styles.ld} ${styles.e4}`)}
                d={d}
                fill="none"
                stroke="var(--exo-amber)"
                strokeWidth={layout.supersedesWidth}
                strokeDasharray={length}
                style={{ "--L": length } as CSSProperties}
              />
              <path
                className={linkClass(from, to, `${styles.lf} ${styles.e4h}`)}
                d={arrow}
                fill="none"
                stroke="var(--exo-amber)"
                strokeWidth={layout.supersedesWidth}
              />
              <text
                className={linkClass(from, to, `${styles.lf} ${styles.e4h} ${styles.svgText}`)}
                x={label.x}
                y={label.y}
                textAnchor={label.anchor}
                fontSize={label.size}
                fill="var(--exo-amber-text)"
              >
                supersedes
              </text>
            </g>
          );
        }
        const length = Math.round(Math.hypot(b.x - a.x, b.y - a.y) * 10) / 10;
        const look = {
          supports: { stroke: "var(--exo-amber)", width: layout.supportsWidth },
          refines: {
            stroke: "var(--exo-amber)",
            opacity: 0.85,
            width: layout.refinesWidth,
            dash: "1.5 3.5",
          },
          contradicts: {
            stroke: "var(--fg-primary)",
            opacity: 0.55,
            width: layout.contradictsWidth,
            dash: "5 4",
          },
        }[kind] as { stroke: string; width: number; opacity?: number; dash?: string };
        return (
          <line
            key={key}
            className={linkClass(from, to, LINK_MOTION[kind])}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={look.stroke}
            strokeOpacity={look.opacity}
            strokeWidth={look.width}
            // The supports link draws itself in: its dash is its own length.
            strokeDasharray={look.dash ?? length}
            style={look.dash ? undefined : ({ "--L": length } as CSSProperties)}
          />
        );
      })}

      {HERO_NOTES.map((note, index) => {
        const { x, y, label } = at(index);
        const isActive = active === index;
        const classes = [
          styles.node,
          isActive && styles.isActive,
          active !== null && NEIGHBOURS[active].has(index) && styles.isNeighbour,
        ]
          .filter(Boolean)
          .join(" ");
        const name = shortNames ? noteName(note.path) : note.path;
        const { strike } = layout;
        return (
          <g
            key={note.path}
            className={classes}
            data-note={index}
            onPointerEnter={hover(index)}
            onPointerLeave={hover(null)}
            onClick={() => {
              if (pointer.current === "mouse") return;
              ignoreMouseUntil.current = performance.now() + 2000;
              onActive(isActive ? null : index, true);
            }}
          >
            <circle className={styles.hit} cx={x} cy={y} r={layout.hitRadius} />
            <circle
              className={styles.ring}
              cx={x}
              cy={y}
              r={layout.ringRadius}
              fill="none"
              stroke="var(--exo-amber)"
              strokeWidth={layout.ringStroke}
            />
            {note.role === "note" && (
              <circle
                className={styles.mark}
                data-graph-node
                cx={x}
                cy={y}
                r={layout.noteRadius}
                fill={`color-mix(in srgb, var(--fg-primary) ${layout.noteOpacity * 100}%, var(--bg-section))`}
              />
            )}
            {note.role === "entity" && (
              <rect
                className={styles.mark}
                data-graph-node
                x={x - layout.entitySize / 2}
                y={y - layout.entitySize / 2}
                width={layout.entitySize}
                height={layout.entitySize}
                fill="var(--bg-section)"
                stroke="var(--fg-muted)"
                strokeWidth={layout.entityStroke}
              />
            )}
            {note.role === "superseded" && (
              <circle
                className={styles.mark}
                data-graph-node
                cx={x}
                cy={y}
                r={layout.supersededRadius}
                fill="var(--bg-base)"
                stroke="var(--fg-muted)"
                strokeWidth={layout.supersededStroke}
              />
            )}
            {note.answer === 3 && (
              <circle
                className={`${styles.mark} ${styles.halo}`}
                cx={x}
                cy={y}
                r={layout.haloRadius}
                fill="var(--exo-amber)"
              />
            )}
            {note.answer && (
              <circle
                className={`${styles.mark} ${styles.rn} ${ANSWER_MOTION[note.answer]}`}
                data-graph-node
                cx={x}
                cy={y}
                r={layout.answerRadius[note.answer]}
              />
            )}
            <text
              className={`${styles.svgText} ${label.onDemand ? styles.hl : ""}`}
              x={label.x}
              y={label.y}
              textAnchor={label.anchor ?? "middle"}
              fontSize={label.onDemand ? layout.onDemandLabelSize : layout.labelSize}
              fill={LABEL_FILL[label.tone]}
              stroke="var(--bg-section)"
              strokeWidth={layout.labelHalo}
              strokeLinejoin="round"
              paintOrder="stroke"
              opacity={label.tone === "muted" ? layout.mutedLabelOpacity : undefined}
            >
              {name}
            </text>
            {note.role === "superseded" && (
              <line
                className={`${styles.ld} ${styles.strike}`}
                x1={strike.x1}
                y1={strike.y}
                x2={strike.x2}
                y2={strike.y}
                stroke="var(--fg-muted)"
                strokeWidth={strike.width}
                strokeDasharray={strike.x2 - strike.x1}
                style={{ "--L": strike.x2 - strike.x1 } as CSSProperties}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function LegendSample({ kind, phone }: { kind: Exclude<LinkKind, "relates">; phone: boolean }) {
  const width = phone ? 16 : 18;
  const tall = kind === "supersedes" || !phone;
  const y = tall ? 4 : 3;
  return (
    <svg
      width={width}
      height={tall ? 8 : 6}
      aria-hidden="true"
      className={phone ? responsive.phoneOnly : responsive.deskOnly}
    >
      {kind === "supports" && (
        <line x1="0" y1={y} x2={width} y2={y} stroke="var(--exo-amber)" strokeWidth="2" />
      )}
      {kind === "refines" && (
        <line
          x1="0"
          y1={y}
          x2={width}
          y2={y}
          stroke="var(--exo-amber)"
          strokeWidth={phone ? 1.4 : 1.3}
          strokeDasharray="1.5 3"
        />
      )}
      {kind === "contradicts" && (
        <line
          x1="0"
          y1={y}
          x2={width}
          y2={y}
          stroke="var(--fg-primary)"
          strokeOpacity=".6"
          strokeWidth="1.2"
          strokeDasharray="5 3"
        />
      )}
      {kind === "supersedes" && (
        <path
          d={`M0 4 H${width - 2} M${width - 6} 1 L${width - 2} 4 L${width - 6} 7`}
          fill="none"
          stroke="var(--exo-amber)"
          strokeWidth="1.4"
        />
      )}
    </svg>
  );
}

const LEGEND = ["supports", "refines", "contradicts", "supersedes"] as const;

/**
 * The hero panel: an assistant asks, the notes it reads light up, the support draws in,
 * the old plan is struck through, and the answer appears, on a 6.5 s loop. Reduced motion
 * shows the finished answer, still. Hovering (or tapping) a note names it and pauses the loop.
 */
export function HeroPanel({ latency }: { latency: string }) {
  const [active, setActive] = useState<number | null>(null);
  const [tapped, setTapped] = useState(false);
  const onActive = (note: number | null, tap = false) => {
    setActive(note);
    setTapped(tap);
  };

  // A note lit by a tap goes out, and the loop resumes, when the next tap lands anywhere
  // but on that note. (A tap on the note itself toggles it in HeroGraph.)
  useEffect(() => {
    if (active === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === "mouse") return;
      if (event.target instanceof Element && event.target.closest(`[data-note="${active}"]`)) {
        return;
      }
      setActive(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    const timer = tapped ? window.setTimeout(() => setActive(null), 1800) : undefined;
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, tapped]);

  const answer = HERO_NOTES[ANSWER_NOTE].path;
  const superseded = HERO_NOTES[SUPERSEDED_NOTE].path;
  return (
    <div className={styles.panel} data-paused={active !== null || undefined}>
      <div className={styles.query}>
        <span className={styles.ask}>
          <span className={styles.app}>Claude ›</span>{" "}
          <span className={styles.q}>what is our current release plan?</span>
        </span>
        <span className={`${styles.row} ${styles.r3} ${styles.latency}`}>{latency}</span>
      </div>
      <HeroGraph
        layout={DESKTOP_LAYOUT}
        shortNames={false}
        className={responsive.deskOnly}
        active={active}
        onActive={onActive}
      />
      <HeroGraph
        layout={PHONE_LAYOUT}
        shortNames
        className={responsive.phoneOnly}
        active={active}
        onActive={onActive}
      />
      <div className={styles.answer}>
        <div className={`${styles.row} ${styles.r1} ${styles.answerRow}`}>
          <span>
            → <span className={responsive.deskOnly}>{answer}</span>
            <span className={responsive.phoneOnly}>{noteName(answer)}</span>
          </span>
          <span className={styles.current}>approved · current</span>
        </div>
        <div className={`${styles.row} ${styles.r2} ${styles.answerRow} ${styles.old}`}>
          <span className={styles.struck}>
            → <span className={responsive.deskOnly}>{superseded}</span>
            <span className={responsive.phoneOnly}>{noteName(superseded)}</span>
          </span>
          <span>
            <span className={responsive.deskOnly}>superseded · kept for history</span>
            <span className={responsive.phoneOnly}>superseded, kept</span>
          </span>
        </div>
      </div>
      <div className={styles.legend}>
        {LEGEND.map((kind) => (
          <span key={kind} className={styles.legendItem}>
            <LegendSample kind={kind} phone={false} />
            <LegendSample kind={kind} phone />
            {kind}
          </span>
        ))}
      </div>
    </div>
  );
}
