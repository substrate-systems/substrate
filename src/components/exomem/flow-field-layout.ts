// The flow field's web: notes scattered around the page's content column and linked
// to their nearest neighbours. A port of graph() in the Journey board (field "web"),
// with the board's seed, so the same screen size draws the same web.

import { trimEdge } from "./alive-engine";
import { clearGraphHeader, type GraphHeader } from "./graph-header";

type FieldNode = { x: number; y: number; s: number; nd: number; hub: boolean };
type FieldEdge = {
  x: number;
  y: number;
  w: number;
  a: number;
  dd: number;
  i: number;
  j: number;
  /** Drawn from the start; the other links grow in, or draw in while connecting. */
  base: boolean;
};
export type FieldLayout = {
  vw: number;
  vh: number;
  nodes: FieldNode[];
  edges: FieldEdge[];
  adjBase: number[][];
  walkable: number[];
};

type Point = { x: number; y: number };

// The board's seeded generator: the same seed gives the same web on every load.
function rng(seed: number) {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (value: number, digits: number) => Number(value.toFixed(digits));

function seg(a: Point, b: Point) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    x: round(a.x, 1),
    y: round(a.y, 1),
    w: round(Math.hypot(dx, dy), 1),
    a: round((Math.atan2(dy, dx) * 180) / Math.PI, 2),
  };
}

/**
 * Lays out the web for a vw × vh page. `phone` uses the phone density; `footer`
 * keeps the strip under the content clear for the request footer (pages opened by an app).
 */
export function buildFieldLayout(
  vw: number,
  vh: number,
  phone: boolean,
  footer: boolean,
  header: GraphHeader = { boxes: [], controls: [] }
): FieldLayout {
  // The page's own furniture stays clear: the content column, the wordmark, the header's right side.
  const box = phone
    ? { x0: -1, x1: vw + 1, y0: 120, y1: vh - 110 }
    : { x0: vw / 2 - 290, x1: vw / 2 + 290, y0: 100, y1: vh - 90 };
  const blocked = (x: number, y: number) =>
    (x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1) ||
    (x < 140 && y < 62) ||
    (!phone && x > vw - 270 && y < 62) ||
    (footer && x > vw / 2 - 140 && x < vw / 2 + 140 && y > vh - 56);

  const rnd = rng(23);
  const count = phone ? 44 : 96;
  const minD = phone ? 34 : 46;
  const pts: Point[] = [];
  for (let tries = 0; pts.length < count && tries < 40000; tries++) {
    const x = 18 + rnd() * (vw - 36);
    const y = 18 + rnd() * (vh - 36);
    if (blocked(x, y)) continue;
    if (pts.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 > minD * minD)) pts.push({ x, y });
  }

  clearGraphHeader(
    pts.map((p) => Object.assign(p, { r: 4.5 })),
    [],
    header
  );

  // Each note links to its three nearest neighbours within reach.
  const links: [number, number][] = [];
  const seen = new Set<string>();
  const adj: number[][] = pts.map(() => []);
  const maxL = phone ? 110 : 150;
  pts.forEach((p, i) => {
    pts
      .map((q, j): [number, number] => [j, (q.x - p.x) ** 2 + (q.y - p.y) ** 2])
      .filter((pair) => pair[0] !== i)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3)
      .forEach(([j, d]) => {
        if (Math.sqrt(d) > maxL) return;
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (
          seen.has(key) ||
          !clearGraphHeader(pts as (Point & { r: number })[], [[i, j]], {
            boxes: [],
            controls: header.controls,
          }).length
        )
          return;
        seen.add(key);
        links.push([i, j]);
        adj[i].push(j);
        adj[j].push(i);
      });
  });

  // Depth from the centre: connecting draws outward, ring by ring.
  const cx = vw / 2;
  const cy = vh / 2;
  const depth = pts.map(() => -1);
  const queue = pts
    .map((p, i): [number, number] => [i, Math.hypot(p.x - cx, p.y - cy)])
    .sort((a, b) => a[1] - b[1])
    .slice(0, 7)
    .map((o) => o[0]);
  queue.forEach((i) => {
    depth[i] = 0;
  });
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    adj[i].forEach((j) => {
      if (depth[j] < 0) {
        depth[j] = depth[i] + 1;
        queue.push(j);
      }
    });
  }
  pts.forEach((p, i) => {
    if (depth[i] < 0) depth[i] = Math.round(Math.hypot(p.x - cx, p.y - cy) / 170);
  });
  const maxD = Math.max(1, ...depth);
  const stepT = Math.min(0.14, 1.25 / maxD);
  const degree = adj.map((a) => a.length);
  const hubs = new Set(
    degree
      .map((d, i) => [i, d])
      .sort((a, b) => b[1] - a[1])
      .slice(0, phone ? 5 : 9)
      .map((a) => a[0])
  );
  const base = links.map(() => rnd() < 0.34);
  const adjBase: number[][] = pts.map(() => []);
  links.forEach(([i, j], k) => {
    if (base[k]) {
      adjBase[i].push(j);
      adjBase[j].push(i);
    }
  });

  const nodes = pts.map((p, i) => {
    const s = Math.round(Math.min(9, 2.6 + degree[i] * 0.95));
    return {
      x: Math.round(p.x - s / 2),
      y: Math.round(p.y - s / 2),
      s,
      nd: round(depth[i] * stepT + 0.22, 2),
      hub: hubs.has(i),
    };
  });
  // Round 41: a link stops at each note's edge, so no line shows through a note.
  const edgeOf = (i: number) => ({
    x: nodes[i].x + nodes[i].s / 2,
    y: nodes[i].y + nodes[i].s / 2,
    r: nodes[i].s / 2,
  });
  const edges = links.map(([i, j], k) => {
    const [a, b] = depth[i] <= depth[j] ? [i, j] : [j, i];
    const [start, end] = trimEdge(edgeOf(a), edgeOf(b));
    return {
      ...seg(start, end),
      dd: round(depth[a] * stepT + rnd() * 0.25, 2),
      i,
      j,
      base: base[k],
    };
  });
  const walkable = pts.map((_, i) => i).filter((i) => adjBase[i].length > 0);
  return { vw, vh, nodes, edges, adjBase, walkable };
}
