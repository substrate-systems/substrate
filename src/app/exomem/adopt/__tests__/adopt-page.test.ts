import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { ReactElement } from "react";

test("adopt page is private, force-dynamic, and mounts the client journey under PrivateShell", async (context) => {
  // The CSS module is a build-time artifact; node resolves it to class names.
  mock.module("../../private-shell.module.css", { defaultExport: {} });
  context.after(() => mock.reset());
  const page = await import("../page");
  assert.equal(page.dynamic, "force-dynamic");
  assert.equal(page.revalidate, 0);
  assert.equal(page.metadata.referrer, "no-referrer");
  const robots = page.metadata.robots as { index?: boolean; follow?: boolean; nocache?: boolean };
  assert.equal(robots.index, false);
  assert.equal(robots.follow, false);
  assert.equal(robots.nocache, true);

  const { PrivateShell } = await import("../../private-shell");
  const adoptClient = (await import("../adopt-client")).default;
  const element = page.default() as ReactElement<{ children: ReactElement }>;
  assert.equal(element.type, PrivateShell);
  assert.equal(element.props.children.type, adoptClient);
});
