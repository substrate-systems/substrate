import assert from "node:assert/strict";
import { test } from "node:test";
import { uploadOrigin, type BrowserIdentity } from "../cloud-import-envelope";

// One case per branch of the mapping: Client Hints where a browser sends them, else the
// User-Agent string, and `other` for anything outside the closed families.
const cases: [string, BrowserIdentity, string, string][] = [
  [
    "Android Chrome by its hints",
    {
      userAgent: "Mozilla/5.0 (Linux; Android 10; K) Chrome/140.0 Mobile Safari/537.36",
      userAgentData: {
        mobile: true,
        platform: "Android",
        brands: [{ brand: "Google Chrome" }, { brand: "Chromium" }],
      },
    },
    "phone",
    "chrome",
  ],
  [
    "a desktop Edge by its hints",
    {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/140.0",
      userAgentData: {
        mobile: false,
        platform: "Windows",
        brands: [{ brand: "Microsoft Edge" }, { brand: "Chromium" }],
      },
    },
    "desktop",
    "edge",
  ],
  [
    "another Chromium browser on an Android tablet",
    {
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/140.0 Safari/537.36",
      userAgentData: { mobile: false, platform: "Android", brands: [{ brand: "Chromium" }] },
    },
    "tablet",
    "other",
  ],
  [
    "iPhone Safari",
    {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    },
    "phone",
    "safari",
  ],
  [
    "iPadOS Safari, which presents itself as a Mac with a touch screen",
    {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      maxTouchPoints: 5,
    },
    "tablet",
    "safari",
  ],
  [
    "Chrome on iPhone",
    {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
    },
    "phone",
    "chrome",
  ],
  [
    "desktop Firefox",
    { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" },
    "desktop",
    "firefox",
  ],
  [
    "Opera on Android",
    {
      userAgent:
        "Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/125.0 Mobile Safari/537.36 OPR/82.0",
      userAgentData: {
        mobile: true,
        platform: "Android",
        brands: [{ brand: "Opera" }, { brand: "Chromium" }],
      },
    },
    "phone",
    "other",
  ],
  ["an unknown client", { userAgent: "curl/8.0" }, "other", "other"],
];

for (const [name, identity, device, browser] of cases) {
  test(`origin families: ${name}`, () => {
    assert.deepEqual(uploadOrigin(identity, ""), {
      device_family: device,
      browser_family: browser,
    });
  });
}

// The cell drops a whole label that holds an unprintable character or is too long
// (import_stage.origin_values). Home sends only what the cell keeps: invisible characters become
// spaces or go, and the label stops at 120 characters.
test("the person's label is sent as the cell keeps it, and left out when nothing is left", () => {
  const identity = { userAgent: "curl/8.0" };
  const sent = (label: string) => uploadOrigin(identity, label).label;
  assert.equal(sent("  Mum's phone 📷 "), "Mum's phone 📷");
  assert.equal(sent("Notes\tfrom\u00a0work"), "Notes from work");
  assert.equal(sent("Zero\u200bwidth"), "Zerowidth");
  assert.equal(sent("é".repeat(130)), "é".repeat(120));
  assert.equal(sent(" \u200b "), undefined);
});
