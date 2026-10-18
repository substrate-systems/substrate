import { chmodSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test as base } from "@playwright/test";
import { createOwner, pool, setCell, signIn } from "./seed";
import { storeTheme, switchTheme } from "../exomem-design/accessibility";

const sourceRef = "exomem://memory/12345678-1234-4234-8234-123456789012";
const identity = { instance: "test-registry", definition_key: "vault.checks" };
const graph = {
  state: "complete",
  available: true,
  reason: null,
  snapshot: null,
  observed_at: "2026-10-15T00:00:00Z",
  ranking_complete: true,
  truncation: [],
  nodes: [
    {
      node_key: "file:target.md",
      kind: "file",
      path: "target.md",
      title: "Lab result",
      source_hash: "b".repeat(64),
      incoming_edges: 1,
      memory_ref: null,
      page_type: "experiment",
      origin_date: null,
      updated_date: null,
    },
    {
      node_key: "file:source.md",
      kind: "file",
      path: "source.md",
      title: "First observation",
      source_hash: "a".repeat(64),
      incoming_edges: 0,
      memory_ref: sourceRef,
      page_type: "insight",
      origin_date: "2026-09-01",
      updated_date: "2026-10-01",
    },
  ],
  edges: [
    {
      edge_key: "edge-a",
      src_key: "file:source.md",
      dst_key: "file:target.md",
      relation_type: "vault.checks",
      source_path: "source.md",
      relation_identity: identity,
    },
  ],
  vocabulary: [
    {
      ...identity,
      description: "Checks the target",
      family: "testing",
      direction: "directed",
      presentation_role: "conflict",
    },
  ],
  counts: {
    eligible_nodes: 2,
    eligible_edges: 1,
    observed_nodes: 2,
    observed_edges: 1,
    drawn_nodes: 2,
    drawn_edges: 1,
  },
};
const sourceNote = {
  path: "source.md",
  ref: sourceRef,
  frontmatter: { title: "First observation", type: "insight" },
  content_hash: "a".repeat(64),
  mtime: 1_792_022_400,
  body: "# First observation\n\nA **visible finding**.\n\n[Unsafe link](javascript:alert(1))\n\n![Chart](https://image.example.test/tracker)\n\n<script>window.noteScriptRuns = true</script>",
};

const test = base.extend<object, { database: void }>({
  database: [
    async ({}, use) => {
      await use();
      await pool.end();
    },
    { scope: "worker", auto: true },
  ],
});

test("the read-only viewer filters source relations, searches and safely reads a note", async ({
  page,
  context,
}) => {
  const owner = await createOwner();
  await setCell(owner, {
    viewerMap: graph,
    viewerSearch: {
      hits: [
        {
          result_type: "semantic_unit",
          parent_title: "First observation",
          parent_path: "source.md",
          parent_ref: sourceRef,
          excerpt: "A visible finding.",
        },
      ],
      continuation: "next-page",
    },
    viewerNotes: { [sourceRef]: sourceNote },
  });
  const imageRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "image.example.test") imageRequests.push(request.url());
  });
  await signIn(context, owner);
  await storeTheme(page, "dark");
  // The deferred map has no Home entry; the existing viewer keeps its direct route.
  await page.goto("/exomem/viewer");
  await expect(page.getByRole("heading", { name: "Your knowledge" })).toBeVisible();
  await expect(page.getByText("2 shown of 2 notes", { exact: true })).toBeVisible();
  const chip = page.getByRole("button", { name: "vault.checks", exact: true });
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "First observation", exact: true }).first().click();
  await expect(
    page
      .getByRole("complementary", { name: "Around this note" })
      .getByText("A visible finding.", { exact: true })
  ).toBeVisible();
  // Measure the settled note panel, rather than an intermediate frame of its approved fade.
  await page.getByRole("complementary", { name: "Around this note" }).evaluate(async (panel) => {
    await Promise.all(
      panel.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))
    );
  });

  for (const theme of ["dark", "light"] as const) {
    await switchTheme(page, theme);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(
      result.violations.filter((row) => row.impact === "serious" || row.impact === "critical")
    ).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
  }

  await page.getByRole("searchbox", { name: "Search notes" }).fill("observation");
  await expect(page.getByRole("button", { name: "More results", exact: true })).toBeVisible();
  await setCell(owner, { viewerSearch: [{ path: "target.md", title: "Lab result" }] });
  await page.getByRole("button", { name: "More results", exact: true }).click();
  await expect(page.getByRole("button", { name: "Lab result", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "More results", exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "First observation A visible finding.", exact: true })
    .click();
  const reader = page.getByRole("region", { name: "Note reader" });
  await expect(reader.getByRole("heading", { name: "First observation" })).toBeFocused();
  await expect(reader.getByRole("heading", { name: "First observation", exact: true })).toHaveCount(
    1
  );
  await expect(reader.getByText("visible finding", { exact: true })).toBeVisible();
  await expect(reader.locator("img, script")).toHaveCount(0);
  await expect(reader.getByRole("link", { name: "Unsafe link" })).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, "noteScriptRuns"))).toBeUndefined();
  expect(imageRequests).toEqual([]);
  expect(new URL(page.url()).search).toBe("");
  await reader.getByRole("button", { name: "← map", exact: true }).click();
  await page.getByRole("button", { name: "← overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your knowledge" })).toBeVisible();

  const directory = process.env.VIEWER_QA_DIR;
  if (directory) {
    const path = join(
      directory,
      `viewer-state-${test.info().project.name.includes("phone") ? "phone" : "desktop"}.json`
    );
    await context.storageState({ path });
    chmodSync(path, 0o600);
  }
});

test("an account change clears the previous owner's cached graph before reading a note", async ({
  page,
  context,
}) => {
  const alice = await createOwner(),
    bob = await createOwner();
  await setCell(alice, { viewerMap: graph, viewerNotes: { [sourceRef]: sourceNote } });
  await signIn(context, alice);
  await page.goto("/exomem/viewer");
  await page.getByRole("button", { name: "First observation", exact: true }).first().click();
  await signIn(context, bob);
  const raisePanel = page.getByRole("button", { name: "Raise the panel", exact: true });
  if (await raisePanel.isVisible()) await raisePanel.click();
  await page.getByRole("button", { name: "Read the note →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in to see your notes" })).toBeVisible();
  await expect(page.getByText("First observation", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Note reader" })).toHaveCount(0);
});

test("a partial view keeps unknown totals and holds its real data while out of reach", async ({
  page,
  context,
}) => {
  const owner = await createOwner();
  const partial = {
    ...graph,
    state: "partial",
    ranking_complete: false,
    counts: { ...graph.counts, eligible_nodes: null, eligible_edges: null },
  };
  await setCell(owner, { viewerMap: partial });
  await signIn(context, owner);
  await page.goto("/exomem/viewer");
  await expect(
    page.getByText("2 shown · total unknown · partial view", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("Unknown", { exact: true })).toHaveCount(2);
  await setCell(owner, { viewerMap: { available: false } });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText(/Can’t reach Exomem. Showing the view from/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "First observation", exact: true }).first()
  ).toBeVisible();
  await setCell(owner, { viewerMap: graph });
  await page.getByRole("button", { name: "Try now", exact: true }).click();
  await expect(page.getByText("2 shown of 2 notes", { exact: true })).toBeVisible();
  await expect(page.getByText(/Can’t reach Exomem. Showing the view from/)).toHaveCount(0);
});
