import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { whatsNewDigestConfig } from "../config";
import { rankMonthNotes } from "../model";
import type { MonthNote } from "../notes";
import { startModel, type ModelStandIn } from "./stand-ins";

// The ranking's branches that the workflow test does not drive: what the code makes of an answer
// that is short, long or wrong, and of a request the API rejects. The answers are served over HTTP
// in the shape the Messages API returns.

const notes: MonthNote[] = Array.from({ length: 8 }, (_, position) => ({
  version: "1.0.0",
  position,
  title: null,
  text: `Change ${position}.`,
}));
const at = (...positions: number[]) =>
  positions.map((position) => ({ version: "1.0.0", position }));

describe("the monthly ranking call", () => {
  let model: ModelStandIn;
  const config = () => ({
    ...whatsNewDigestConfig({}),
    anthropicBaseUrl: model.origin,
    anthropicApiKey: "test-key",
  });
  const rank = (key: string | null = "test-key") =>
    rankMonthNotes(notes, { ...config(), anthropicApiKey: key }, { retryDelayMs: 0 });

  before(async () => {
    model = await startModel();
  });
  after(() => model.close());

  it("reads an answer under the bar of three as none", async () => {
    model.requests.length = 0;
    model.answers.push({ picks: at(3, 1) });
    assert.deepEqual(await rank(), {
      kind: "ranked",
      picks: [],
      modelId: "claude-haiku-5-5",
      promptVersion: "1",
    });
  });

  it("keeps the first six of a longer ranked list", async () => {
    model.answers.push({ picks: at(7, 6, 5, 4, 3, 2, 1, 0) });
    const outcome = await rank();
    assert.ok(outcome.kind === "ranked");
    assert.deepEqual(outcome.picks, at(7, 6, 5, 4, 3, 2));
  });

  it("leaves the month waiting, after one retry, when the model names a note the month does not have", async () => {
    model.requests.length = 0;
    model.answers.push(
      { picks: [...at(0, 1), { version: "9.9.9", position: 0 }] },
      { picks: at(0, 0, 1) }
    );
    assert.deepEqual(await rank(), { kind: "unavailable" });
    assert.equal(model.requests.length, 2);
  });

  it("does not retry a request the API rejects", async () => {
    model.requests.length = 0;
    model.answers.push({ status: 401 });
    assert.deepEqual(await rank(), { kind: "unavailable" });
    assert.equal(model.requests.length, 1);
  });

  it("makes no call without a key", async () => {
    model.requests.length = 0;
    assert.deepEqual(await rank(null), { kind: "not_configured" });
    assert.equal(model.requests.length, 0);
  });
});
