import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  adjacentImageIndices,
  boundedViewerIndex,
  swipeNavigationDirection,
} from "../viewer-state";

describe("photography viewer navigation", () => {
  it("moves within the sequence without wrapping at either end", () => {
    assert.equal(boundedViewerIndex(0, -1, 13), 0);
    assert.equal(boundedViewerIndex(0, 1, 13), 1);
    assert.equal(boundedViewerIndex(12, 1, 13), 12);
    assert.equal(boundedViewerIndex(12, -1, 13), 11);
  });

  it("loads only the current image and its immediate neighbours", () => {
    assert.deepEqual(adjacentImageIndices(0, 13), [0, 1]);
    assert.deepEqual(adjacentImageIndices(6, 13), [5, 6, 7]);
    assert.deepEqual(adjacentImageIndices(12, 13), [11, 12]);
  });

  it("turns intentional horizontal swipes into bounded navigation", () => {
    assert.equal(swipeNavigationDirection(200, 100), 1);
    assert.equal(swipeNavigationDirection(100, 200), -1);
    assert.equal(swipeNavigationDirection(100, 130), 0);
  });
});
