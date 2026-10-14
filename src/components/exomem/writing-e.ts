import { PRESETS } from "./dot-e";

export type MarkState =
  | "rest"
  | "recall"
  | "save"
  | "working"
  | "progress"
  | "done"
  | "failed"
  | "off";

/** Where each step ends along the stroke of L dots. */
export function stepEnds(L: number, n: number): number[] {
  const p = PRESETS[L] && PRESETS[L][n];
  return p ? p : Array.from({ length: n }, (_, i) => Math.round((((i + 1) * L) / n) * 100) / 100);
}

/** The three numbers for a state. step i of n running (0-based); i >= n means all done. */
export function markNumbers(
  L: number,
  state: MarkState,
  opts: { steps?: number; step?: number; value?: number } = {}
) {
  if (state === "working") return { w: 0, b: L, rest: 0, cls: "indet" };
  if (state === "done") return { w: L, b: L, rest: 0, cls: "done" };
  if (state === "failed") return { w: 0, b: 0, rest: 0, cls: "" };
  if (state === "progress") {
    if (typeof opts.value === "number") {
      const v = Math.max(0, Math.min(1, opts.value)),
        w = Math.round(L * v * 100) / 100;
      return { w, b: Math.min(L, w + 1), rest: 0, cls: v >= 1 ? "done" : "" };
    }
    const n = Math.max(1, opts.steps ?? 1),
      i = Math.max(0, opts.step ?? 0),
      e = stepEnds(L, n);
    return i >= n
      ? { w: L, b: L, rest: 0, cls: "done" }
      : { w: i ? e[i - 1] : 0, b: e[i], rest: 0, cls: "" };
  }
  const cls =
    state === "recall" ? "recall" : state === "save" ? "save" : state === "off" ? "off" : "breathe";
  return { w: 0, b: 0, rest: 1, cls };
}
