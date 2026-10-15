import assert from "node:assert/strict";
import { it } from "node:test";
import { activityEventKey, createActivityObserver, type ActivityEvent } from "../home-activity";
import type { HomeActivity } from "../home-api";

const first: ActivityEvent = {
  app_id: "00000000-0000-4000-8000-000000000001",
  client: "claude-ai",
  action: "recalled",
  items: 2,
  at: "2026-10-12T09:59:00Z",
};

function feed(events: ActivityEvent[]): HomeActivity {
  return {
    state: "live",
    since: "2026-10-12T08:00:00Z",
    as_of: "2026-10-12T10:00:00Z",
    note_count: 3,
    events,
  };
}

it("keeps initial history quiet and publishes a new event only once", () => {
  const observe = createActivityObserver();
  assert.equal(observe(feed([first])), null);
  const next = { ...first, at: "2026-10-12T10:00:01Z" };
  assert.equal(observe(feed([next, first])), next);
  assert.equal(observe(feed([next, first])), null);
  assert.equal(observe(feed([first])), null, "aging rows cannot replay older activity");
});

it("does not confuse equal-time activity from two grants of the same provider", () => {
  const observe = createActivityObserver();
  assert.equal(observe(feed([first])), null);
  const second = { ...first, app_id: "00000000-0000-4000-8000-000000000002" };
  assert.notEqual(activityEventKey(first), activityEventKey(second));
  assert.equal(observe(feed([second, first])), second);
  assert.equal(observe(feed([first, second])), null);
});

it("holds its observation across a failed read without replaying history", () => {
  const observe = createActivityObserver();
  assert.equal(observe(feed([first])), null);
  assert.equal(observe({ state: "unavailable", reason: "CELL_UNREACHABLE" }), null);
  assert.equal(observe(feed([first])), null);
  const next = { ...first, at: "2026-10-12T10:00:02Z" };
  assert.equal(observe(feed([next])), next);
});

it("recognizes the first event after an initially empty feed", () => {
  const observe = createActivityObserver();
  assert.equal(observe(feed([])), null);
  const next = { ...first, at: "2026-10-12T10:00:01Z" };
  assert.equal(observe(feed([next])), next);
});
