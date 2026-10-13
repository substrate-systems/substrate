"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { buildFieldLayout, type FieldLayout } from "./flow-field-layout";
import phoneStyles from "./phone.module.css";
import styles from "./FlowField.module.css";

/**
 * What the field shows, from the page's state (kindOf() in the Journey board):
 * quiet — before anything connects: a light walks, nothing grows;
 * live — the consent page: the light walks and the web grows a link now and then;
 * hold — paying or confirming: still;
 * go — connecting: links draw in;
 * done — connected: amber settles and signals run;
 * stop — ended or an error: grey.
 */
export type FieldKind = "quiet" | "live" | "hold" | "go" | "done" | "stop";

// The design widths the web is laid out at; it is then scaled to the page's width.
const DESKTOP_WIDTH = 1280;
const PHONE_WIDTH = 390;
// The light walks one note further every 1.15 s; a walk sometimes jumps (12%).
const WALK_MS = 1150;
const WALK_JUMP = 0.12;
// The consent page grows a link on 45% of walks, up to 14 new links.
const GROW_CHANCE = 0.45;
const GROW_MAX = 14;
// Glow hover: the nearest note within 70 px lights; notes within 120 px wake.
const LIGHT_RADIUS = 70;
const WAKE_RADIUS = 120;
// The pointer the glow follows eases toward the real one (a quarter per frame).
const POINTER_EASE = 0.25;

function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}

const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)];

type Walk = { focus: number; prev: number; grown: number[]; sig: number[]; sigI: number };
const START: Walk = { focus: -1, prev: -1, grown: [], sig: [-1, -1, -1], sigI: 0 };

function step(walk: Walk, kind: FieldKind, layout: FieldLayout): Walk {
  if (kind === "done") {
    // Connected: a signal runs along a different link on each beat (three at a time).
    const sig = [...walk.sig];
    sig[walk.sigI % 3] = Math.floor(Math.random() * layout.edges.length);
    return { ...walk, sig, sigI: walk.sigI + 1, focus: -1 };
  }
  const next = { ...walk };
  if (kind === "live" && walk.grown.length < GROW_MAX && Math.random() < GROW_CHANCE) {
    const pool = layout.edges
      .map((e, k) => (!e.base && !walk.grown.includes(k) ? k : -1))
      .filter((k) => k >= 0);
    if (pool.length) next.grown = [...walk.grown, pick(pool)];
  }
  const options = walk.focus >= 0 ? layout.adjBase[walk.focus].filter((j) => j !== walk.prev) : [];
  if (!options.length || Math.random() < WALK_JUMP) {
    if (!layout.walkable.length) return next;
    return { ...next, prev: -1, focus: pick(layout.walkable) };
  }
  return { ...next, prev: walk.focus, focus: pick(options) };
}

type Hover = { c0: number; c1: Set<number> };
const NO_HOVER: Hover = { c0: -1, c1: new Set() };

/**
 * The living web behind the flow pages. It fills its positioned parent, scales with
 * its width, lays out against the parent's real height, and lights the note under
 * the pointer (desktop only). Everything holds still under reduced motion.
 */
export function FlowField({ kind, footer = false }: { kind: FieldKind; footer?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number; phone: boolean } | null>(null);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const coarse = useMediaQuery("(pointer: coarse)");

  // Measure the parent. A height change alone (a phone's address bar) keeps the web as it is.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height) return;
      // The phone layout follows the shared breakpoint in phone.module.css.
      const phone = getComputedStyle(host).getPropertyValue("--field-phone").trim() === "1";
      setSize((old) =>
        old && old.width === width && old.phone === phone ? old : { width, height, phone }
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const phone = size?.phone ?? false;
  const layout = useMemo(() => {
    if (!size) return null;
    const vw = phone ? PHONE_WIDTH : DESKTOP_WIDTH;
    return buildFieldLayout(vw, Math.round((size.height * vw) / size.width), phone, footer);
  }, [size, phone, footer]);

  const [walk, setWalk] = useState<Walk>(START);
  const walking = !reduced && (kind === "quiet" || kind === "live" || kind === "done");
  useEffect(() => {
    if (!walking || !layout) return;
    const timer = setInterval(() => setWalk((w) => step(w, kind, layout)), WALK_MS);
    return () => clearInterval(timer);
  }, [walking, kind, layout]);

  // Glow hover, off on touch screens and phones, under reduced motion, and while the page holds or has stopped.
  const [hover, setHover] = useState<Hover>(NO_HOVER);
  const hovering = !!layout && !reduced && !coarse && !phone && kind !== "hold" && kind !== "stop";
  useEffect(() => {
    const host = hostRef.current;
    const page = host?.parentElement;
    if (!hovering || !layout || !host || !page) return;
    let target: [number, number] | null = null;
    let eased: [number, number] | null = null;
    let shown = NO_HOVER;
    let frame = 0;

    const paint = () => {
      frame = 0;
      eased =
        target && eased
          ? [
              eased[0] + (target[0] - eased[0]) * POINTER_EASE,
              eased[1] + (target[1] - eased[1]) * POINTER_EASE,
            ]
          : target;
      let c0 = -1;
      let best = LIGHT_RADIUS;
      const c1 = new Set<number>();
      if (eased) {
        const [mx, my] = eased;
        layout.nodes.forEach((n, i) => {
          const d = Math.hypot(n.x + n.s / 2 - mx, n.y + n.s / 2 - my);
          if (d < best) {
            best = d;
            c0 = i;
          }
          if (d < WAKE_RADIUS) c1.add(i);
        });
        c1.delete(c0);
      }
      // Re-render only when the lit or waking notes change, not on every frame.
      if (c0 !== shown.c0 || c1.size !== shown.c1.size || [...c1].some((i) => !shown.c1.has(i))) {
        shown = { c0, c1 };
        setHover(shown);
      }
      if (eased) frame = requestAnimationFrame(paint);
    };
    const onMove = (event: MouseEvent) => {
      const rect = host.getBoundingClientRect();
      if (!rect.width) return;
      const scale = rect.width / layout.vw;
      target = [(event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale];
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onLeave = () => {
      target = null;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    page.addEventListener("mousemove", onMove);
    page.addEventListener("mouseleave", onLeave);
    return () => {
      page.removeEventListener("mousemove", onMove);
      page.removeEventListener("mouseleave", onLeave);
      cancelAnimationFrame(frame);
      setHover(NO_HOVER);
    };
  }, [hovering, layout]);

  const scale = size && layout ? size.width / layout.vw : 1;

  const phase = kind === "go" ? "s-connecting" : kind === "done" ? "s-connected" : "s-consent";
  const live = walking && kind !== "done";
  const focus = live ? walk.focus : -1;
  const near = new Set(focus >= 0 && layout ? layout.adjBase[focus] : []);
  const grown = new Set(walk.grown);
  const sig = new Set(kind === "done" ? walk.sig : []);
  const cls = (...names: (string | false)[]) =>
    names
      .filter((n): n is string => !!n)
      .map((n) => styles[n])
      .join(" ");

  return (
    <div ref={hostRef} className={`${styles.field} ${phoneStyles.fieldLayout}`} aria-hidden="true">
      {layout && size && (
        <div
          className={cls("canvas", "m-web", phase, kind === "stop" && "k-stop")}
          style={
            {
              // Paint at the final CSS size so zoom and DPR do not resample a raster layer.
              width: size.width,
              height: layout.vh * scale,
              "--field-scale": scale,
            } as CSSProperties
          }
        >
          {layout.edges.map((e, k) => (
            <div
              key={`e${k}`}
              className={cls(
                "ge",
                (e.i === focus || e.j === focus) && e.base && "on",
                !e.base && "nw",
                grown.has(k) && "gr",
                sig.has(k) && "sg",
                hover.c0 >= 0 && (e.i === hover.c0 || e.j === hover.c0) && "cn"
              )}
              style={
                {
                  left: e.x * scale,
                  top: e.y * scale,
                  width: e.w * scale,
                  transform: `rotate(${e.a}deg)`,
                  "--dd": `${e.dd}s`,
                } as CSSProperties
              }
            >
              <div className={styles.gi} />
              <div className={styles.gp} />
            </div>
          ))}
          {layout.nodes.map((n, i) => (
            <div
              key={`n${i}`}
              className={cls(
                "gn",
                i === focus ? "on" : near.has(i) && "near",
                n.hub && "hub",
                hover.c0 === i && "c0",
                hover.c1.has(i) && "c1"
              )}
              style={
                {
                  left: n.x * scale,
                  top: n.y * scale,
                  width: n.s * scale,
                  height: n.s * scale,
                  "--nd": `${n.nd}s`,
                } as CSSProperties
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
