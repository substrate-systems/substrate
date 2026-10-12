import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proofFigures, type RecallBenchmarks } from "../proof";

const measured = (findTotalMs: { min: number; max: number }, findMedianMs: number) =>
  ({
    source: "docs/benchmarks.md",
    realVault: { findTotalMs },
    scale: { notes: 120000, findMedianMs },
  }) satisfies RecallBenchmarks;

describe("the landing's proof figures", () => {
  // Fails if a figure is typed into the page instead of following the measurement file.
  it("follow a new measurement", () => {
    assert.deepEqual(proofFigures(measured({ min: 380, max: 640 }, 910)), {
      recall: "≈ 0.5 s",
      heroLatency: "510 ms",
      scaleNotes: "120,000",
    });
  });

  // Fails if a slow recall is written in exponent form ("≈ 1e+1 s").
  it("write a slow recall in plain digits", () => {
    assert.equal(proofFigures(measured({ min: 9500, max: 13000 }, 910)).recall, "≈ 10 s");
  });

  // Fails if the page keeps saying "still under a second" after a slower measurement.
  it("refuse a measurement that breaks the under-a-second caption", () => {
    assert.throws(() => proofFigures(measured({ min: 94, max: 159 }, 1200)), /under a second/);
  });
});
