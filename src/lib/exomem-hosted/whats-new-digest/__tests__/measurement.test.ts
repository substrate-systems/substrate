import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { measure, shareOf, switchApplies } from "../measurement";
import type { MonthRecord } from "../months";

const note = (position: number) => ({ version: "1.0.0", position });

function month(
  name: string,
  model: number[] | null,
  operator: number[] | null,
  overrides: Partial<MonthRecord> = {}
): MonthRecord {
  return {
    month: name,
    state: "ready_to_queue",
    skipReason: null,
    releasesListedAt: null,
    lastCheckedAt: null,
    modelStatus: null,
    modelId: "model-a",
    promptVersion: "1",
    modelSelection: model && model.map(note),
    blindPick: operator && operator.map(note),
    decision: "approved",
    finalSelection: [note(0), note(1), note(2)],
    decidedAt: null,
    ...overrides,
  };
}

const configured = { modelId: "model-a", promptVersion: "1" };

describe("the model's share of the operator's blind picks", () => {
  it("is the notes in both picks over the operator's picks, two thirds passing", () => {
    assert.deepEqual(
      [month("2026-01", [0, 1, 2], [0, 1, 9]), month("2026-02", [0, 1, 2], [0, 8, 9])].map(
        (m) => shareOf(m)?.passes
      ),
      [true, false]
    );
    assert.equal(shareOf(month("2026-01", [0, 1, 2, 3], [0, 1, 2, 3, 4, 5]))?.passes, true);
    assert.equal(shareOf(month("2026-01", [0, 1], [0, 1, 2, 3, 4, 5]))?.passes, false);
  });

  it("scores a month the model left empty and the operator filled as 0, and counts it", () => {
    const share = shareOf(month("2026-01", [], [0, 1, 2]));
    assert.deepEqual([share?.both, share?.operatorPicks, share?.passes], [0, 3, false]);
  });

  it("leaves a quiet month, or one that was not approved or edited, out of the count", () => {
    assert.equal(shareOf(month("2026-01", [], [])), null);
    assert.equal(shareOf(month("2026-01", [0, 1, 2], [0, 1, 2], { decision: "automatic" })), null);
    assert.equal(shareOf(month("2026-01", [0, 1, 2], null)), null);
  });
});

describe("the measurement", () => {
  const passing = (name: string, overrides: Partial<MonthRecord> = {}) =>
    month(name, [0, 1, 2], [0, 1, 2], overrides);

  it("offers the switch after three passing months of one model and prompt", () => {
    assert.equal(measure([passing("2026-01"), passing("2026-02")], configured).offered, false);
    const done = measure([passing("2026-01"), passing("2026-02"), passing("2026-03")], configured);
    assert.deepEqual([done.complete, done.allPass, done.offered], [true, true, true]);
  });

  it("does not offer it when any of the three is below two thirds", () => {
    const weak = month("2026-02", [0, 1, 2], [0, 7, 8]);
    assert.equal(
      measure([passing("2026-01"), weak, passing("2026-03")], configured).offered,
      false
    );
  });

  it("restarts the count when the model or the prompt changes", () => {
    const months = [
      passing("2026-01"),
      passing("2026-02"),
      passing("2026-03", { promptVersion: "2" }),
      passing("2026-04", { promptVersion: "2" }),
    ];
    const result = measure(months, { modelId: "model-a", promptVersion: "2" });
    assert.deepEqual(
      result.run.map((share) => share.month),
      ["2026-03", "2026-04"]
    );
    assert.equal(result.complete, false);
  });

  it("does not offer a switch measured under a model that is no longer configured", () => {
    const months = [passing("2026-01"), passing("2026-02"), passing("2026-03")];
    assert.equal(measure(months, { modelId: "model-b", promptVersion: "1" }).offered, false);
  });

  it("reads only the first three months of the run, so later months cannot move the verdict", () => {
    const months = [
      passing("2026-01"),
      passing("2026-02"),
      passing("2026-03"),
      month("2026-04", [], [0, 1, 2]),
    ];
    assert.equal(measure(months, configured).allPass, true);
  });
});

describe("the recorded switch", () => {
  const record = (overrides = {}) => ({
    sendWithoutApproval: true,
    modelId: "model-a",
    promptVersion: "1",
    shares: [],
    recordedAt: new Date(),
    ...overrides,
  });

  it("applies only to the model and prompt it was measured under", () => {
    assert.equal(switchApplies(record(), configured), true);
    assert.equal(switchApplies(record({ modelId: "model-b" }), configured), false);
    assert.equal(switchApplies(record({ promptVersion: "2" }), configured), false);
    assert.equal(switchApplies(record({ sendWithoutApproval: false }), configured), false);
    assert.equal(switchApplies(null, configured), false);
  });
});
