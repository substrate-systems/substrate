/**
 * ExomemMark: the Dot E, alive. One component for every place the mark appears in the product.
 *
 *   <ExomemMark size={40} state="conn" />
 *
 * States: idle (the lit row breathes), recall (the row waves, the frame flickers), save (the row writes in),
 * conn (the frame lights in order, then the whole E stays lit), off (the accent goes out).
 * Below 32 px it switches to the small cut automatically. Reduced motion keeps colour and shape, drops movement.
 */
import * as React from "react";

export type ExomemMarkState = "idle" | "recall" | "save" | "conn" | "off";

const FULL = {
  r: 2.2,
  frame: [
    [13.6, 8.4], [18.8, 8.4], [24, 8.4], [29.2, 8.4], [34.4, 8.4],
    [13.6, 13.6], [13.6, 18.8], [13.6, 29.2], [13.6, 34.4],
    [13.6, 39.6], [18.8, 39.6], [24, 39.6], [29.2, 39.6], [34.4, 39.6],
  ],
  row: [[13.6, 24], [18.8, 24], [24, 24], [29.2, 24]],
};
const SMALL = {
  // one even pitch (7.5) both ways, same dot-to-gap ratio and height as FULL, so the switch at 32 px never jumps
  r: 3.1,
  frame: [[16.5, 9], [24, 9], [31.5, 9], [16.5, 16.5], [16.5, 31.5], [16.5, 39], [24, 39], [31.5, 39]],
  row: [[16.5, 24], [24, 24]],
};

export const EXOMEM_MARK_CSS = `
.exo-mark .f{fill:var(--exo-fg,#ECE9E2);transition:fill .5s ease}
.exo-mark .r{fill:var(--exo-accent,#FFB000);transform-box:fill-box;transform-origin:center;transition:fill .5s ease,opacity .5s ease}
.exo-mark[data-state=idle] .r{animation:exoBreath 3.2s ease-in-out infinite;animation-delay:calc(var(--i)*.2s)}
.exo-mark[data-state=recall] .r{animation:exoWave 1.1s ease-in-out infinite;animation-delay:calc(var(--i)*.14s)}
.exo-mark[data-state=recall] .f{animation:exoSweep 1.5s ease-out infinite;animation-delay:var(--d)}
.exo-mark[data-state=save] .r{animation:exoWrite .5s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i)*.16s)}
.exo-mark[data-state=conn] .f{fill:var(--exo-accent,#FFB000);animation:exoIgnite .7s ease-out both;animation-delay:var(--d)}
.exo-mark[data-state=conn] .r{animation:exoSettle .9s cubic-bezier(.16,1,.3,1) both;animation-delay:calc(var(--i)*.06s)}
.exo-mark[data-state=off] .f{fill:#5C574D}
.exo-mark[data-state=off] .r{fill:#5C574D;opacity:.55}
@keyframes exoBreath{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes exoWave{0%,100%{opacity:.35;transform:scale(.88)}50%{opacity:1;transform:scale(1.08)}}
@keyframes exoSweep{0%{fill:var(--exo-accent,#FFB000)}30%,100%{fill:var(--exo-fg,#ECE9E2)}}
@keyframes exoWrite{0%{opacity:0;transform:scale(1.9)}100%{opacity:1;transform:scale(1)}}
@keyframes exoIgnite{0%{fill:var(--exo-fg,#ECE9E2)}100%{fill:var(--exo-accent,#FFB000)}}
@keyframes exoSettle{0%{transform:scale(1.5);opacity:.4}100%{transform:scale(1);opacity:1}}
@media (prefers-reduced-motion: reduce){.exo-mark *{animation:none!important;transition:none!important}}
`;

export function ExomemMark({
  size = 40,
  state = "idle",
  label = "Exomem",
  className,
}: {
  size?: number;
  state?: ExomemMarkState;
  label?: string;
  className?: string;
}) {
  const g = size < 32 ? SMALL : FULL;
  return (
    <svg
      className={["exo-mark", className].filter(Boolean).join(" ")}
      data-state={state}
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role="img"
      aria-label={label}
    >
      {g.frame.map(([x, y], k) => (
        <circle key={`f${k}`} className="f" cx={x} cy={y} r={g.r} style={{ ["--d" as string]: `${k * 0.05}s` }} />
      ))}
      {g.row.map(([x, y], i) => (
        <circle key={`r${i}`} className="r" cx={x} cy={y} r={g.r} style={{ ["--i" as string]: i }} />
      ))}
    </svg>
  );
}

/** Render once near the root, for example in the Exomem layout. */
export function ExomemMarkStyles() {
  return <style dangerouslySetInnerHTML={{ __html: EXOMEM_MARK_CSS }} />;
}
