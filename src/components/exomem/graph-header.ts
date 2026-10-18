import {
  clearBoxes,
  linkClearOf,
} from "../../../docs/exomem-design/reference/engine/graph-layout.js";

export type GraphHeader = { boxes: number[][]; controls: { cx: number; cy: number; r: number }[] };

/** Measure the real header, including addresses whose width comes from account data. */
export function graphHeader(svg: Element, width: number, height: number): GraphHeader {
  const area = svg.getBoundingClientRect();
  const surface = svg.closest("[data-alive-surface]");
  if (!surface || !area.width || !area.height) return { boxes: [], controls: [] };
  const sx = width / area.width;
  const sy = height / area.height;
  const boxes: number[][] = [];
  const controls: GraphHeader["controls"] = [];
  for (const element of surface.querySelectorAll<HTMLElement>("[data-graph-clear]")) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const box = [
      (rect.left - area.left) * sx,
      (rect.top - area.top) * sy,
      (rect.right - area.left) * sx,
      (rect.bottom - area.top) * sy,
    ];
    boxes.push(box);
    if (element.hasAttribute("data-graph-control"))
      controls.push({
        cx: (box[0] + box[2]) / 2,
        cy: (box[1] + box[3]) / 2,
        r: Math.max(box[2] - box[0], box[3] - box[1]) / 2,
      });
  }
  return { boxes, controls };
}

/** Reuse the canon's layout helpers; round 55's rejected edge rules stay unused. */
export function clearGraphHeader(
  nodes: { x: number; y: number; r: number }[],
  edges: readonly (readonly [number, number])[],
  header: GraphHeader
) {
  clearBoxes(nodes, header.boxes, { margin: 10 });
  return edges.filter(([i, j]) =>
    header.controls.every((control) => linkClearOf(nodes[i], nodes[j], control))
  );
}
