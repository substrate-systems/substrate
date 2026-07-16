import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), "utf8");
}

describe("photography routes", () => {
  it("frames photography as part of the same Substrate practice", () => {
    const page = source("src/app/photography/page.tsx");
    assert.match(page, /The same eye, elsewhere\./);
    assert.match(page, /icelandAuroraSeries\.title/);
    assert.match(page, /icelandAuroraSeries\.date/);
    assert.match(page, /href=["{]'?\/photography\/iceland-aurora/);
  });

  it("renders a linear gallery from the authored series", () => {
    const page = source("src/app/photography/iceland-aurora/page.tsx");
    assert.match(page, /icelandAuroraSeries/);
    assert.match(page, /PhotographyGallery/);
  });

  it("uses the site metadata builder with canonical route paths", () => {
    const index = source("src/app/photography/page.tsx");
    const series = source("src/app/photography/iceland-aurora/page.tsx");
    assert.match(index, /buildMetadata/);
    assert.match(index, /path: "\/photography"/);
    assert.match(series, /buildMetadata/);
    assert.match(series, /path: "\/photography\/iceland-aurora"/);
  });

  it("credits Hugo Ander Kivi as the photographer on both routes", () => {
    const index = source("src/app/photography/page.tsx");
    const series = source("src/app/photography/iceland-aurora/page.tsx");
    assert.match(index, /authors: \["Hugo Ander Kivi"\]/);
    assert.match(series, /authors: \["Hugo Ander Kivi"\]/);
  });

  it("implements the modal accessibility and bounded-loading contract", () => {
    const viewer = source("src/components/photography/PhotographyGallery.tsx");
    assert.match(viewer, /role="dialog"/);
    assert.match(viewer, /aria-modal="true"/);
    assert.match(viewer, /aria-live="polite"/);
    assert.match(viewer, /inert/);
    assert.match(viewer, /document\.body\.style\.overflow/);
    assert.match(viewer, /adjacentImageIndices/);
    assert.match(viewer, /priority=\{index === 0\}/);
    assert.match(viewer, /loading=\{index === 0 \? "eager" : "lazy"\}/);
  });
});
