import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import type { SimulationNodeDatum } from "d3-force";
import type { ViewerMapView } from "@/lib/exomem-hosted/cloud-viewer";

export function layoutMap(map: ViewerMapView) {
  const nodes = map.nodes.map((note) => ({
    ...note,
    x: undefined,
    y: undefined,
  })) as (ViewerMapView["nodes"][number] & SimulationNodeDatum)[];
  const links = map.edges.map((edge) => ({ source: edge.src_key, target: edge.dst_key }));
  // D3 owns placement; the fixed drawing limit bounds the static layout's work.
  forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-100))
    .force(
      "links",
      forceLink(links)
        .id((node) => nodes[node.index!].node_key)
        .distance(70)
    )
    .force("collision", forceCollide(24))
    .force("center", forceCenter(0, 0))
    .stop()
    .tick(100);
  const xs = nodes.map((node) => node.x ?? 0);
  const ys = nodes.map((node) => node.y ?? 0);
  const left = Math.min(0, ...xs),
    top = Math.min(0, ...ys);
  const width = Math.max(1, Math.max(0, ...xs) - left);
  const height = Math.max(1, Math.max(0, ...ys) - top);
  return nodes.map((node) => ({
    ...node,
    x: nodes.length === 1 ? 500 : 100 + (((node.x ?? 0) - left) * 800) / width,
    y: nodes.length === 1 ? 350 : 100 + (((node.y ?? 0) - top) * 500) / height,
    r: 3 + Math.min(7, Math.sqrt(node.incoming_edges ?? 0)),
  }));
}

// These are the five line treatments implemented by the approved viewer design.
// Registry entry names never choose a treatment; absent or future roles use plain ink.
const LINE_TREATMENTS: Record<
  string,
  { width: number; dash?: string; amber: boolean; overview: string; selected: number }
> = {
  support: { width: 2, amber: true, overview: "var(--graph-link-supports)", selected: 0.85 },
  refinement: {
    width: 1,
    dash: "2 4",
    amber: true,
    overview: "var(--graph-link-refines)",
    selected: 0.9,
  },
  conflict: {
    width: 1,
    dash: "7 5",
    amber: false,
    overview: "var(--graph-link-contradicts)",
    selected: 0.7,
  },
  replacement: { width: 1.5, amber: true, overview: "var(--graph-link-supersedes)", selected: 0.8 },
  association: { width: 1, amber: false, overview: "var(--graph-link)", selected: 0.35 },
};

export function relationLine(role?: string | null) {
  return role && Object.hasOwn(LINE_TREATMENTS, role)
    ? LINE_TREATMENTS[role]
    : LINE_TREATMENTS.association;
}

export function primaryRelations(vocabulary: ViewerMapView["vocabulary"]) {
  return Object.keys(LINE_TREATMENTS).flatMap((role) => {
    const meaning = vocabulary.find((entry) => entry.presentation_role === role);
    return meaning ? [meaning] : [];
  });
}

export function relationIdentity(value: { instance: string; definition_key: string }) {
  return JSON.stringify([value.instance, value.definition_key]);
}
