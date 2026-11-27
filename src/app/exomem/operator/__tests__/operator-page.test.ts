import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";

describe("Exomem operator page", () => {
  it("is private, dynamic, excluded from indexing and sends no referrer", async (context) => {
    // Only the page module's exports are under test: its stylesheet and client
    // component (more stylesheets) are stood in for, since this runner loads no CSS.
    mock.module("../../home/home.module.css", { defaultExport: {} });
    mock.module("../operator-client", { defaultExport: () => null });
    context.after(() => mock.reset());
    const page = await import("../page");
    const robots = page.metadata.robots as { index?: boolean; follow?: boolean; nocache?: boolean };
    assert.equal(page.dynamic, "force-dynamic");
    assert.equal(page.revalidate, 0);
    assert.equal(robots.index, false);
    assert.equal(robots.follow, false);
    assert.equal(robots.nocache, true);
    assert.equal(page.metadata.referrer, "no-referrer");
  });

  it("keeps the bearer in React memory and reuses the existing admin APIs", () => {
    // The page's calls and the one request function that sends the bearer, which every operator page shares.
    const source = ["operator-client.tsx", "operator-request.ts"]
      .map((file) => readFileSync(`src/app/exomem/operator/${file}`, "utf8"))
      .join("\n");
    assert.match(source, /\/api\/exomem\/admin\/capacity/);
    assert.match(source, /\/api\/exomem\/admin\/invites/);
    assert.match(source, /Authorization:\s*`Bearer \$\{bearer\}`/);
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|URLSearchParams/);
  });
});
