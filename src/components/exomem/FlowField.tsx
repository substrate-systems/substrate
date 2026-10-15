"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { fireAlive, useAliveGraph, type AliveEvent } from "./AliveGraph";
import { TAP_MOUSE_QUIET_MS, TAP_MS } from "./alive-engine";
import { buildFieldLayout } from "./flow-field-layout";
import phoneStyles from "./phone.module.css";
import styles from "./FlowField.module.css";

export type FieldKind = "quiet" | "live" | "hold" | "go" | "done" | "stop";

// The Journey board's pacing and reach (Journey-Page.dc.html: walk(), webTick(), onTap()).
const WALK_MS = 1150;
const GROWN_MAX = 14;
const LIT_REACH = 70; // viewBox units: the closest note within reach takes the light
const WAKE_REACH = 120; // the notes within reach wake
const CONNECT_EVENT_MS = 500;

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (change: () => void) => {
  const query = matchMedia(REDUCED);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};
function useReducedMotion() {
  return useSyncExternalStore(
    subscribeReduced,
    () => matchMedia(REDUCED).matches,
    () => false
  );
}

const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];
const mark = (element: Element | undefined, name: string, value: string | null) => {
  if (!element || element.getAttribute(name) === value) return;
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
};
const seconds = (style: CSSStyleDeclaration, name: string) => {
  const value = style.getPropertyValue(name).trim();
  return value.endsWith("ms") ? parseFloat(value) / 1000 : parseFloat(value) || 0;
};

/**
 * The board's field: a light walks the notes, the web grows a link now and then, the
 * pointer lights the closest note, and connecting lights the whole web from the centre.
 * The shared engine adds its quiet ink pulses and the page's own events on top.
 */
export function FlowField({
  kind,
  footer = false,
  activity,
  checkout = false,
  onLit,
}: {
  kind: FieldKind;
  footer?: boolean;
  activity?: AliveEvent;
  /** Behind the checkout the walking light is held dim. */
  checkout?: boolean;
  /** Connecting: called once the whole web has lit. */
  onLit?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const id = `field-${useId()}`;
  const reduced = useReducedMotion();
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
  const layout = useMemo(() => {
    if (!size) return null;
    const width = size.phone ? 390 : 1280;
    return buildFieldLayout(
      width,
      Math.round((size.height * width) / size.width),
      size.phone,
      footer
    );
  }, [size, footer]);
  const incident = useMemo(() => {
    const links: number[][] = layout ? layout.nodes.map(() => []) : [];
    layout?.edges.forEach((e, k) => {
      links[e.i].push(k);
      links[e.j].push(k);
    });
    return links;
  }, [layout]);
  // The engine runs on the resting web only. A page holds still while it waits on a
  // confirmation; behind the checkout the web keeps working until the payment lands.
  const engine = kind === "stop" ? "cut" : kind === "hold" && !checkout ? "still" : "live";
  const event = useMemo<AliveEvent | undefined>(
    () => activity ?? (kind === "hold" && checkout ? { kind: "work", on: true } : undefined),
    [activity, kind, checkout]
  );
  const graph = useMemo(
    () =>
      layout
        ? JSON.stringify({
            n: layout.nodes.map((n) => [n.x + n.s / 2, n.y + n.s / 2, n.s / 2]),
            e: layout.edges.filter((e) => e.base).map((e) => [e.i, e.j]),
          })
        : "",
    [layout]
  );
  const svg = useAliveGraph(id, engine, graph, event);
  const grown = useRef(new Set<number>());
  const walk = useRef({ focus: -1, prev: -1, sig: [-1, -1, -1], sigI: 0 });
  useEffect(() => {
    grown.current = new Set();
    walk.current = { focus: -1, prev: -1, sig: [-1, -1, -1], sigI: 0 };
  }, [layout]);

  // Connected: the engine's own connect light follows the field's.
  useEffect(() => {
    if (kind !== "done") return;
    const timer = window.setTimeout(() => fireAlive(id, { kind: "connect" }), CONNECT_EVENT_MS);
    return () => window.clearTimeout(timer);
  }, [kind, id]);

  // Connecting lasts until the last note and link have lit, with or without motion.
  useEffect(() => {
    const element = svg.current;
    if (kind !== "go" || !onLit) return;
    // A field that could not be laid out has nothing to play; it never holds up the page.
    if (!layout || !element) {
      onLit();
      return;
    }
    const style = getComputedStyle(element);
    const hit = seconds(style, "--hit");
    const draw = seconds(style, "--draw");
    const glowIn = seconds(style, "--glow-in");
    const end = Math.max(
      ...layout.nodes.map((n) => n.nd + hit),
      ...layout.edges.map((e, k) => e.dd + (e.base || grown.current.has(k) ? glowIn : draw))
    );
    const timer = window.setTimeout(onLit, end * 1000);
    return () => window.clearTimeout(timer);
  }, [kind, layout, onLit, svg]);

  // The walking light, the links the web grows, and the signals on a connected web.
  useEffect(() => {
    const element = svg.current;
    if (!element || !layout) return;
    const nodes = [...element.querySelectorAll("[data-node]")];
    const edges = [...element.querySelectorAll("[data-edge]")];
    const state = walk.current;
    const show = (on: boolean) => {
      const focus = on && kind !== "done" ? state.focus : -1;
      const near = new Set(focus >= 0 ? layout.adjBase[focus] : []);
      nodes.forEach((node, i) =>
        mark(node, "data-walker", i === focus ? "on" : near.has(i) ? "near" : null)
      );
      layout.edges.forEach((e, k) => {
        const lit = focus >= 0 && e.base && (e.i === focus || e.j === focus);
        mark(edges[k], "data-walker", lit ? "on" : null);
        mark(edges[k], "data-sig", on && kind === "done" && state.sig.includes(k) ? "" : null);
      });
    };
    if (reduced || (kind !== "quiet" && kind !== "live" && kind !== "done")) {
      show(false);
      return;
    }
    show(true);
    const step = () => {
      if (kind === "live" && grown.current.size < GROWN_MAX && Math.random() < 0.45) {
        const pool = layout.edges.flatMap((e, k) => (!e.base && !grown.current.has(k) ? [k] : []));
        if (pool.length) {
          const k = pick(pool);
          grown.current.add(k);
          mark(edges[k], "data-grown", "");
        }
      }
      if (kind === "done") {
        state.sig[state.sigI % 3] = Math.floor(Math.random() * layout.edges.length);
        state.sigI += 1;
        state.focus = -1;
        return;
      }
      const next =
        state.focus >= 0 ? layout.adjBase[state.focus].filter((j) => j !== state.prev) : [];
      if (!next.length || Math.random() < 0.12) {
        state.prev = -1;
        state.focus = layout.walkable.length ? pick(layout.walkable) : -1;
      } else {
        state.prev = state.focus;
        state.focus = pick(next);
      }
    };
    const timer = window.setInterval(() => {
      step();
      show(true);
    }, WALK_MS);
    return () => window.clearInterval(timer);
  }, [kind, layout, reduced, svg]);

  // Glow hover (R37 C, shipped on every flow page): nothing moves. The closest note lights,
  // its links warm, the ones nearby wake. A tap lights it for a moment. Holding and stopped
  // pages take no hover, and neither does the field under reduced motion (the board's onMove).
  // The pointer outlives a change of step, so the light stays under a resting pointer.
  const pointer = useRef<{ at: { x: number; y: number } | null; tapAt: number; tapTimer: number }>({
    at: null,
    tapAt: -Infinity,
    tapTimer: 0,
  });
  useEffect(() => () => window.clearTimeout(pointer.current.tapTimer), []);
  useEffect(() => {
    const element = svg.current;
    if (!element || !layout) return;
    if (kind === "hold" || kind === "stop" || reduced) {
      pointer.current.at = null;
      return;
    }
    const surface = element.closest("[data-alive-surface]") ?? element.parentElement;
    if (!surface) return;
    const nodes = [...element.querySelectorAll("[data-node]")];
    const edges = [...element.querySelectorAll("[data-edge]")];
    const centres = layout.nodes.map((n) => [n.x + n.s / 2, n.y + n.s / 2] as const);
    const state = pointer.current;
    let eased: [number, number] | null = null;
    let lit = -1;
    let shown = new Set<number>();
    let frame = 0;
    const show = (best: number, wake: Set<number>) => {
      if (best !== lit) {
        if (lit >= 0) {
          incident[lit].forEach((k) => mark(edges[k], "data-hover", null));
          mark(nodes[lit], "data-hover", null);
        }
        if (best >= 0) incident[best].forEach((k) => mark(edges[k], "data-hover", ""));
        lit = best;
      }
      for (const i of new Set([...shown, ...wake]))
        mark(nodes[i], "data-hover", wake.has(i) ? "near" : null);
      if (best >= 0) mark(nodes[best], "data-hover", "lit");
      shown = wake;
    };
    const tick = () => {
      frame = 0;
      const matrix = element.getScreenCTM();
      if (!state.at || !matrix) {
        eased = null;
        show(-1, new Set());
        return;
      }
      // The page can scroll under a still pointer, so the pointer is mapped every frame.
      const p = new DOMPoint(state.at.x, state.at.y).matrixTransform(matrix.inverse());
      const [ex, ey] = eased
        ? [eased[0] + (p.x - eased[0]) * 0.25, eased[1] + (p.y - eased[1]) * 0.25]
        : [p.x, p.y];
      eased = [ex, ey];
      let best = -1;
      let bestDistance = LIT_REACH;
      const wake = new Set<number>();
      centres.forEach(([x, y], i) => {
        const distance = Math.hypot(x - ex, y - ey);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        }
        if (distance < WAKE_REACH) wake.add(i);
      });
      wake.delete(best);
      show(best, wake);
      frame = requestAnimationFrame(tick);
    };
    const follow = () => {
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const tapped = () => performance.now() - state.tapAt < TAP_MOUSE_QUIET_MS;
    const move = (event: Event) => {
      const { pointerType, clientX, clientY } = event as PointerEvent;
      if (pointerType !== "mouse" || tapped()) return;
      state.at = { x: clientX, y: clientY };
      follow();
    };
    const leave = () => {
      if (tapped()) return;
      state.at = null;
      follow();
    };
    const tap = (event: Event) => {
      const { pointerType, clientX, clientY } = event as PointerEvent;
      if (pointerType === "mouse") return;
      state.tapAt = performance.now();
      state.at = { x: clientX, y: clientY };
      window.clearTimeout(state.tapTimer);
      state.tapTimer = window.setTimeout(() => {
        state.at = null;
      }, TAP_MS);
      follow();
    };
    surface.addEventListener("pointermove", move, { passive: true });
    surface.addEventListener("pointerleave", leave);
    surface.addEventListener("pointerdown", tap, { passive: true });
    if (state.at) follow();
    return () => {
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerleave", leave);
      surface.removeEventListener("pointerdown", tap);
      cancelAnimationFrame(frame);
      nodes.forEach((node) => mark(node, "data-hover", null));
      edges.forEach((edge) => mark(edge, "data-hover", null));
    };
  }, [kind, layout, incident, reduced, svg]);

  return (
    <div ref={host} className={`${styles.field} ${phoneStyles.fieldLayout}`} aria-hidden>
      {layout ? (
        <svg
          key={`${layout.vw}x${layout.vh}`}
          ref={svg}
          className={[styles.canvas, styles[kind], checkout && styles.checkout]
            .filter(Boolean)
            .join(" ")}
          viewBox={`0 0 ${layout.vw} ${layout.vh}`}
          data-alive={engine === "live" ? "loop" : "off"}
          data-graph={graph}
          data-alive-key={id}
          data-entry={`${layout.vw / 2},${Math.round(layout.vh * 0.4)}`}
        >
          {layout.edges.map((e, k) => (
            <g
              key={k}
              data-edge
              className={styles.edge}
              data-new={e.base ? undefined : ""}
              transform={`translate(${e.x} ${e.y}) rotate(${e.a})`}
              style={{ "--dd": `${e.dd}s`, "--w": `${e.w}px` } as CSSProperties}
            >
              <line
                className={styles.link}
                x2={e.w}
                data-exo-t=""
                vectorEffect="non-scaling-stroke"
              />
              {kind === "done" ? <circle className={styles.signal} r="2" /> : null}
            </g>
          ))}
          {layout.nodes.map((n, i) => (
            <circle
              key={i}
              data-node
              data-hub={n.hub ? "" : undefined}
              className={styles.node}
              cx={n.x + n.s / 2}
              cy={n.y + n.s / 2}
              r={n.s / 2}
              style={{ "--nd": `${n.nd}s` } as CSSProperties}
            />
          ))}
        </svg>
      ) : null}
    </div>
  );
}
