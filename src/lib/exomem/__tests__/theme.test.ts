import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { exomemThemeScript } from "../theme";

// The inline script runs before React, on every page of the site, in whatever
// browser the visitor has. These run the exact string the root layout ships.
function runBeforePaint(pathname: string, getItem: (key: string) => string | null) {
  const attributes = new Map<string, string>();
  const documentElement = {
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  };
  const window = { localStorage: { getItem } };
  runInNewContext(exomemThemeScript, {
    location: { pathname },
    window,
    document: { documentElement },
  });
  return attributes;
}

describe("the theme is applied before first paint", () => {
  it("marks an Exomem page with the stored light theme", () => {
    const attributes = runBeforePaint("/exomem/home", (key) =>
      key === "exomem-theme" ? "light" : null
    );

    assert.equal(attributes.get("data-theme"), "light");
    assert.equal(attributes.has("data-exomem"), true);
  });

  it("falls back to dark when storage is blocked, rather than breaking the page", () => {
    // Private windows and locked-down browsers throw on any storage access.
    const attributes = runBeforePaint("/exomem", () => {
      throw new Error("SecurityError");
    });

    assert.equal(attributes.get("data-theme"), "dark");
  });

  it("leaves the rest of the site untouched", () => {
    // The marker restyles the page ground and scrollbar; outside /exomem it must not appear,
    // including on a path that only starts with the same letters.
    for (const pathname of ["/", "/blog/exomem-vs-claude-mem", "/exomemx"]) {
      assert.equal(runBeforePaint(pathname, () => "light").size, 0, pathname);
    }
  });
});
