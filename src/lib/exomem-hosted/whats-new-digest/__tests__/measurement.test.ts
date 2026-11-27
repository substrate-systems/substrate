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
    modelReported: "model-a-20261001",
    promptVersion: "p1",
    modelSelection: model && model.map(note),
    blindPick: operator && operator.map(note),
    decision: "approved",
    finalSelection: [note(0), note(1), note(2)],
    decidedAt: null,
    sendAfter: null,
    queuedCount: 0,
    ...overrides,
  };
}

const configured = { modelId: "model-a", promptVersion: "p1" };
const ranked = { modelId: "model-a", modelReported: "model-a-20261001", promptVersion: "p1" };

describe("a month's score", () => {
  it("is the notes in both picks over the larger pick count, two thirds passing", () => {
    assert.deepEqual(
      [month("2026-01", [0, 1, 2], [0, 1, 9]), month("2026-02", [0, 1, 2], [0, 8, 9])].map(
        (m) => shareOf(m)?.passes
      ),
      [true, false]
    );
  });

  it("penalises a model that pads to 6 when the operator picked 3", () => {
    // The operator's 3 are all in the model's 6: 3 of 3 by the operator's count, 3 of 6 by the larger.
    const padded = shareOf(month("2026-01", [0, 1, 2, 3, 4, 5], [0, 1, 2]));
    assert.deepEqual([padded?.both, padded?.operatorPicks, padded?.modelPicks], [3, 3, 6]);
    assert.equal(padded?.passes, false);
    assert.equal(shareOf(month("2026-01", [0, 1, 2, 3], [0, 1, 2]))?.passes, true);
  });

  it("scores 0 and counts when exactly one side picked none, whatever the operator decided", () => {
    const modelNone = shareOf(month("2026-01", [], [0, 1, 2]));
    assert.deepEqual([modelNone?.both, modelNone?.passes], [0, false]);
    // The operator's blind none skips the month; the model would have sent: a disagreement that counts.
    const operatorNone = shareOf(
      month("2026-01", [0, 1, 2], [], { state: "skipped", skipReason: "operator", decision: null })
    );
    assert.deepEqual([operatorNone?.both, operatorNone?.passes], [0, false]);
    const lapsed = shareOf(month("2026-01", [0, 1, 2], [0, 1, 2], { state: "lapsed" }));
    assert.equal(lapsed?.passes, true);
  });

  it("leaves a quiet month, and a month without a blind pick or a ranking, out of the count", () => {
    assert.equal(shareOf(month("2026-01", [], [])), null);
    assert.equal(shareOf(month("2026-01", [0, 1, 2], null)), null);
    assert.equal(shareOf(month("2026-01", null, [0, 1, 2])), null);
    assert.equal(shareOf(month("2026-01", [0, 1, 2], [0, 1, 2], { modelReported: null })), null);
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

  it("restarts the count when the prompt changes", () => {
    const months = [
      passing("2026-01"),
      passing("2026-02"),
      passing("2026-03", { promptVersion: "p2" }),
      passing("2026-04", { promptVersion: "p2" }),
    ];
    const result = measure(months, { modelId: "model-a", promptVersion: "p2" });
    assert.deepEqual(
      result.run.map((share) => share.month),
      ["2026-03", "2026-04"]
    );
    assert.equal(result.complete, false);
  });

  it("restarts the count when the API reports a different model under the same configured name", () => {
    const months = [
      passing("2026-01"),
      passing("2026-02"),
      passing("2026-03", { modelReported: "model-a-20261101" }),
    ];
    const result = measure(months, configured);
    assert.deepEqual(
      result.run.map((share) => share.month),
      ["2026-03"]
    );
    assert.equal(result.offered, false);
  });

  it("does not offer a switch measured under a model that is no longer configured", () => {
    const months = [passing("2026-01"), passing("2026-02"), passing("2026-03")];
    assert.equal(measure(months, { modelId: "model-b", promptVersion: "p1" }).offered, false);
  });

  it("lets a later month in the run withdraw the offer but never grant it", () => {
    const three = [passing("2026-01"), passing("2026-02"), passing("2026-03")];
    const later = measure([...three, month("2026-04", [], [0, 1, 2])], configured);
    assert.deepEqual([later.allPass, later.withdrawn, later.offered], [true, true, false]);
    // A later pass changes nothing; a weak first three are not rescued by later months.
    assert.equal(measure([...three, passing("2026-04")], configured).offered, true);
    const weakStart = [
      month("2026-01", [0, 1, 2], [7, 8, 9]),
      passing("2026-02"),
      passing("2026-03"),
    ];
    assert.equal(measure([...weakStart, passing("2026-04")], configured).offered, false);
  });
});

describe("the recorded switch", () => {
  const record = (overrides = {}) => ({
    sendWithoutApproval: true,
    modelId: "model-a",
    modelReported: "model-a-20261001",
    promptVersion: "p1",
    shares: [],
    recordedAt: new Date(),
    ...overrides,
  });

  it("applies only to the model name, the reported model and the prompt it was measured under", () => {
    assert.equal(switchApplies(record(), ranked), true);
    assert.equal(switchApplies(record({ modelId: "model-b" }), ranked), false);
    assert.equal(switchApplies(record({ modelReported: "model-a-20261101" }), ranked), false);
    assert.equal(switchApplies(record({ promptVersion: "p2" }), ranked), false);
    assert.equal(switchApplies(record({ sendWithoutApproval: false }), ranked), false);
    assert.equal(switchApplies(record({ modelReported: null }), ranked), false);
    assert.equal(switchApplies(null, ranked), false);
  });
});
