import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

import { icelandAuroraSeries } from "../photography.js";

const expectedSources = [
  "/photography/iceland-aurora/01-iceland-aurora-02111.jpg",
  "/photography/iceland-aurora/02-iceland-aurora-02123.jpg",
  "/photography/iceland-aurora/03-iceland-aurora-02125.jpg",
  "/photography/iceland-aurora/04-iceland-aurora-02127.jpg",
  "/photography/iceland-aurora/05-iceland-aurora-02128-3.jpg",
  "/photography/iceland-aurora/06-iceland-aurora-02131.jpg",
  "/photography/iceland-aurora/07-iceland-aurora-02131-3.jpg",
  "/photography/iceland-aurora/08-iceland-aurora-02124-3.jpg",
  "/photography/iceland-aurora/09-iceland-aurora-02126-3.jpg",
  "/photography/iceland-aurora/10-iceland-aurora-02129-3.jpg",
  "/photography/iceland-aurora/11-iceland-aurora-02130-4.jpg",
  "/photography/iceland-aurora/12-iceland-aurora-02132-2.jpg",
  "/photography/iceland-aurora/13-iceland-aurora-02136.jpg",
] as const;

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;

    const segmentLength = bytes.readUInt16BE(offset);
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

    if (isStartOfFrame) {
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }

    offset += segmentLength;
  }

  throw new Error("JPEG dimensions were not found");
}

describe("Iceland aurora photography manifest", () => {
  it("locks the approved editorial sequence and metadata", () => {
    assert.equal(icelandAuroraSeries.slug, "iceland-aurora");
    assert.equal(icelandAuroraSeries.title, "Iceland Aurora");
    assert.equal(icelandAuroraSeries.year, 2026);
    assert.equal(icelandAuroraSeries.date, "March 2026");
    assert.equal(icelandAuroraSeries.location, "Iceland");
    assert.ok(icelandAuroraSeries.introduction.length > 0);
    assert.equal(
      icelandAuroraSeries.cover,
      "/photography/iceland-aurora/11-iceland-aurora-02130-4.jpg"
    );

    assert.equal(icelandAuroraSeries.images.length, 13);
    assert.deepEqual(
      icelandAuroraSeries.images.map((image) => image.src),
      expectedSources
    );
    assert.equal(new Set(icelandAuroraSeries.images.map((image) => image.id)).size, 13);
    assert.deepEqual(
      icelandAuroraSeries.images.map((image) => image.pairWithNext ?? false),
      [false, false, false, false, false, true, false, false, false, false, false, false, false]
    );
    assert.deepEqual(
      new Set(icelandAuroraSeries.images.map((image) => image.treatment)),
      new Set(["colour", "black-and-white"])
    );
    assert.ok(icelandAuroraSeries.images.every((image) => image.alt.length > 0));
  });

  it("ships exactly the selected, correctly sized derivatives", async () => {
    const publicDirectory = path.join(process.cwd(), "public");
    const seriesDirectory = path.join(publicDirectory, "photography", "iceland-aurora");
    const exportedFiles = (await readdir(seriesDirectory))
      .filter((file) => file.toLowerCase().endsWith(".jpg"))
      .sort();

    assert.deepEqual(
      exportedFiles,
      expectedSources.map((src) => path.basename(src))
    );

    for (const image of icelandAuroraSeries.images) {
      assert.equal(image.width, 3000);
      assert.equal(image.height, 2000);

      const bytes = await readFile(path.join(publicDirectory, image.src));
      assert.deepEqual(jpegDimensions(bytes), {
        width: image.width,
        height: image.height,
      });
    }
  });
});
