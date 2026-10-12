// The landing's numbers, worked out from the recall measurements (recall-benchmarks.json)
// when the page renders, so no figure on the page is typed in by hand.

export type RecallBenchmarks = {
  source: string;
  /** A real vault: the min–max of `find()` totals across a handful of fresh queries. */
  realVault: { findTotalMs: { min: number; max: number } };
  /** The largest synthetic vault measured, and its end-to-end `find()` median. */
  scale: { notes: number; findMedianMs: number };
};

export type ProofFigures = {
  /** "≈ 0.1 s", over "to recall from a real vault". */
  recall: string;
  /** "130 ms", the time the hero's recall shows. */
  heroLatency: string;
  /** "50,000", over "notes, still under a second". */
  scaleNotes: string;
};

const ONE_SECOND_MS = 1000;
// One significant figure, always in plain digits ("0.1", "10"), never "1e+1".
const ROUGH_SECONDS = new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 1 });

/**
 * The proof strip and the hero's latency. A typical recall is the middle of the measured
 * real-vault range. The 50,000-note caption says "still under a second"; when a new
 * measurement says otherwise this throws, so the build fails instead of the page claiming
 * something the measurement no longer shows. The fix is new copy, not a different number.
 */
export function proofFigures(benchmarks: RecallBenchmarks): ProofFigures {
  const { min, max } = benchmarks.realVault.findTotalMs;
  const typicalMs = (min + max) / 2;
  if (benchmarks.scale.findMedianMs >= ONE_SECOND_MS) {
    throw new Error(
      `The landing says ${benchmarks.scale.notes} notes recall in under a second, ` +
        `but ${benchmarks.source} measured ${benchmarks.scale.findMedianMs} ms.`
    );
  }
  return {
    recall: `≈ ${ROUGH_SECONDS.format(typicalMs / ONE_SECOND_MS)} s`,
    heroLatency: `${Math.round(typicalMs / 10) * 10} ms`,
    scaleNotes: new Intl.NumberFormat("en-GB").format(benchmarks.scale.notes),
  };
}
