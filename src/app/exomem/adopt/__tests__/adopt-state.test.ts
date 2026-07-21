import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADOPTION_RUN_ID } from "@/lib/exomem-hosted/adoption-staging";
import { HostedBrowserError } from "@/lib/exomem-hosted/hosted-browser";
import {
  answerHits,
  BatchUploadError,
  derivedTree,
  failureGroups,
  flattenProposals,
  folderState,
  initialSelection,
  isFileSelected,
  isTransientPhase,
  junkTotal,
  legalStep,
  newStagingRunSlug,
  nextRunPollDelayMs,
  outcomesToResult,
  overrideFile,
  parseRunDoc,
  phaseScreen,
  planBullets,
  selectionCounts,
  selectionFromRules,
  selectionPayload,
  selectionRoots,
  STAGING_RUN_SLUG,
  stagingPathForRun,
  staleNoticeFor,
  toggleFolder,
  uploadBatch,
  verificationLine,
} from "../adopt-state";

const INVENTORY = [
  { path: "Docs/a.md", eligible: true },
  { path: "Docs/tmp/skip.md", eligible: true },
  { path: "Docs/tmp/keep.md", eligible: true },
  { path: "Journal/day1.md", eligible: true },
  { path: "Photos/pic.jpg", eligible: false, junk: false },
  { path: "Docs/conflict copy.md", eligible: false, junk: true },
];

describe("adoption selection model", () => {
  it("translates explicit choices into the engine payload", () => {
    let sel = initialSelection();
    sel = toggleFolder(sel, "Docs/tmp", false);
    sel = overrideFile(sel, "Docs/tmp/keep.md", true);
    sel = overrideFile(sel, "Docs/a.md", false);
    sel = { ...sel, includeJunk: true };

    // Untouched default-on roots become explicit include entries; a deeper OFF
    // folder rule rides exclude and wins over its ancestor by specificity; an
    // OFF file override rides exclude; an ON file override rides overrides.
    assert.deepEqual(selectionPayload(sel, selectionRoots(INVENTORY)), {
      include: ["Docs", "Journal"],
      exclude: ["Docs/a.md", "Docs/tmp"],
      overrides: ["Docs/tmp/keep.md"],
      includeJunk: true,
    });
  });

  it("never lists a root-level file in both include and exclude", () => {
    // Files staged without a subdirectory are their own selection roots; an
    // explicit file rule must replace the untouched-root include, not fight it.
    const inventory = [
      { path: "loose-a.md", eligible: true },
      { path: "loose-b.md", eligible: true },
      { path: "loose-c.md", eligible: true },
    ];
    const roots = selectionRoots(inventory);
    assert.deepEqual(roots, ["loose-a.md", "loose-b.md", "loose-c.md"]);

    let sel = initialSelection();
    sel = overrideFile(sel, "loose-a.md", false);
    sel = overrideFile(sel, "loose-b.md", true);
    assert.deepEqual(selectionPayload(sel, roots), {
      include: ["loose-c.md"],
      exclude: ["loose-a.md"],
      overrides: ["loose-b.md"],
      includeJunk: false,
    });
  });

  it("resolves effective file state with deepest-rule-wins and override precedence", () => {
    let sel = initialSelection();
    sel = toggleFolder(sel, "Docs", true);
    sel = toggleFolder(sel, "Docs/tmp", false);
    sel = overrideFile(sel, "Docs/tmp/keep.md", true);

    assert.equal(isFileSelected(sel, "Docs/a.md"), true);
    assert.equal(isFileSelected(sel, "Docs/tmp/skip.md"), false);
    assert.equal(isFileSelected(sel, "Docs/tmp/keep.md"), true);
    assert.equal(isFileSelected(sel, "Journal/day1.md"), true);

    const counts = selectionCounts(INVENTORY, sel);
    assert.equal(counts.selectableNotes, 4);
    assert.equal(counts.selectedNotes, 3);
    assert.equal(counts.junkAvailable, 1);
    assert.equal(counts.junkIncluded, 0);
    assert.equal(selectionCounts(INVENTORY, { ...sel, includeJunk: true }).junkIncluded, 1);
  });

  it("makes a folder rule authoritative for its subtree", () => {
    let sel = initialSelection();
    sel = toggleFolder(sel, "Docs/tmp", false);
    sel = overrideFile(sel, "Docs/tmp/keep.md", true);
    sel = overrideFile(sel, "Docs/a.md", false);
    sel = toggleFolder(sel, "Docs", true);

    assert.deepEqual(sel.folders, { Docs: true });
    assert.deepEqual(sel.files, {});
  });

  it("reports tri-state folder checkboxes including mixed subtrees", () => {
    const tree = derivedTree(INVENTORY);
    let sel = initialSelection();
    assert.equal(folderState(sel, tree, "Docs"), "checked");
    sel = toggleFolder(sel, "Docs/tmp", false);
    assert.equal(folderState(sel, tree, "Docs"), "mixed");
    sel = toggleFolder(sel, "Docs", false);
    assert.equal(folderState(sel, tree, "Docs"), "unchecked");
    sel = overrideFile(sel, "Docs/a.md", true);
    assert.equal(folderState(sel, tree, "Docs"), "mixed");
  });

  it("round-trips the model through persisted rules without losing choices", () => {
    let sel = initialSelection();
    sel = toggleFolder(sel, "Docs/tmp", false);
    sel = overrideFile(sel, "Docs/tmp/keep.md", true);
    sel = overrideFile(sel, "Docs/a.md", false);
    sel = { ...sel, includeJunk: true };

    const roots = selectionRoots(INVENTORY);
    const payload = selectionPayload(sel, roots);
    const persistedRules = {
      include: payload.include,
      exclude: payload.exclude,
      overrides: payload.overrides,
      include_junk: payload.includeJunk,
    };
    const resumed = selectionFromRules(
      persistedRules,
      INVENTORY.map((row) => row.path)
    );
    assert.notEqual(resumed, null);
    assert.deepEqual(selectionPayload(resumed!, roots), payload);
    assert.equal(isFileSelected(resumed!, "Docs/a.md"), false);
    assert.equal(isFileSelected(resumed!, "Docs/tmp/keep.md"), true);
    assert.equal(isFileSelected(resumed!, "Docs/tmp/skip.md"), false);
  });

  it("derives selection roots from eligible files only", () => {
    assert.deepEqual(selectionRoots(INVENTORY), ["Docs", "Journal"]);
  });
});

describe("adoption run poll schedule", () => {
  it("polls transient phases on the shared 3s→30s exponential schedule", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 9].map((attempt) => nextRunPollDelayMs("applying", attempt)),
      [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]
    );
    for (const phase of ["created", "scanning", "applying"]) {
      assert.equal(isTransientPhase(phase), true);
      assert.equal(nextRunPollDelayMs(phase, 0), 3_000);
    }
  });

  it("stops polling once the run settles", () => {
    for (const phase of ["selecting", "planned", "applied", "partial", "done", "cancelled", "failed"]) {
      assert.equal(isTransientPhase(phase), false);
      assert.equal(nextRunPollDelayMs(phase, 0), null);
    }
    assert.equal(nextRunPollDelayMs(undefined, 0), null);
  });
});

describe("phase to screen gating", () => {
  it("keeps only reviewable steps routable and snaps the rest to the phase default", () => {
    assert.equal(legalStep("selecting", "choose"), "choose");
    assert.equal(legalStep("selecting", "suggestions"), "findings");
    assert.equal(legalStep("planned", "start"), "preview");
    assert.equal(legalStep("planned", "findings"), "findings");
    assert.equal(legalStep("applied", "suggestions"), "suggestions");
    assert.equal(legalStep("applied", "choose"), "start");
    assert.equal(legalStep("applying", "preview"), "start");
    assert.equal(legalStep("failed", "question"), "start");
  });

  it("lets the server phase win over the requested step", () => {
    assert.equal(phaseScreen(null, "choose"), "start");
    assert.equal(phaseScreen({ phase: "selecting" }, "start"), "findings");
    assert.equal(phaseScreen({ phase: "selecting" }, "choose"), "choose");
    assert.equal(phaseScreen({ phase: "selecting" }, "preview"), "preview");
    assert.equal(phaseScreen({ phase: "planned" }, "start"), "preview");
    assert.equal(phaseScreen({ phase: "applying" }, "choose"), "applying");
    assert.equal(phaseScreen({ phase: "applied" }, "start"), "result");
    assert.equal(phaseScreen({ phase: "partial" }, "start"), "result");
    assert.equal(phaseScreen({ phase: "applied" }, "suggestions"), "proposals");
    assert.equal(phaseScreen({ phase: "done" }, "question"), "question");
    assert.equal(phaseScreen({ phase: "done" }, "start"), "done");
    assert.equal(phaseScreen({ phase: "cancelled" }, "preview"), "cancelled");
    assert.equal(phaseScreen({ phase: "failed" }, "choose"), "failed");
    assert.equal(phaseScreen({ phase: "invented" }, "choose"), "unknown");
  });
});

describe("apply outcome presentation", () => {
  it("groups failures by code with honest plain-language reasons", () => {
    assert.deepEqual(
      failureGroups([
        { path: "a.md", code: "SOURCE_CHANGED" },
        { path: "b.md", code: "SOURCE_CHANGED" },
        { path: "c.md", code: "WEIRD", reason: "disk full" },
        { path: "d.md" },
      ]),
      [
        {
          code: "SOURCE_CHANGED",
          reason: "This file changed after we looked, so we left it untouched.",
          paths: ["a.md", "b.md"],
        },
        { code: "WEIRD", reason: "Couldn't be copied: disk full", paths: ["c.md"] },
        { code: "UNKNOWN", reason: "Couldn't be copied.", paths: ["d.md"] },
      ]
    );
  });

  it("derives copied and failed rows from the outcomes map only", () => {
    const result = outcomesToResult({
      run_id: "run-1",
      phase: "partial",
      outcomes: {
        "Docs/a.md": { status: "applied" },
        "Docs/b.md": { status: "already-applied" },
        "Docs/c.md": { status: "failed", code: "SOURCE_CHANGED", reason: "changed" },
      },
    });
    assert.deepEqual(
      result.copied.map((item) => item.original_path),
      ["Docs/a.md", "Docs/b.md"]
    );
    assert.deepEqual(result.failed, [{ path: "Docs/c.md", code: "SOURCE_CHANGED", reason: "changed" }]);
  });

  it("only claims verification when the run carries real re-hash counts", () => {
    assert.equal(
      verificationLine({ run_id: "r", phase: "applied", verified_unchanged: 41, verified_total: 42 }),
      "We double-checked your originals: 41 of 42 are byte-for-byte unchanged (checksums match)."
    );
    assert.equal(
      verificationLine({ run_id: "r", phase: "applied" }),
      "We didn't re-check your originals this time — but nothing was moved, edited, or deleted."
    );
  });

  it("previews exact totals and always states the no-mutation guarantee", () => {
    const { bullets, total } = planBullets({ copy: 12, skip_unsupported: 3, skip_junk: 2 });
    assert.equal(total, 17);
    assert.deepEqual(bullets, [
      "12 text notes will be copied in",
      "3 photos & other files stay put (not copied — not supported yet)",
      "2 junk files will be skipped",
      "0 files will be changed, moved, or deleted — always",
    ]);
  });
});

describe("run document and proposal parsing", () => {
  it("accepts only run documents with an id and phase, sanitizing inventory rows", () => {
    assert.equal(parseRunDoc(null), null);
    assert.equal(parseRunDoc({ phase: "selecting" }), null);
    assert.equal(parseRunDoc({ run_id: "run-1" }), null);
    const doc = parseRunDoc({
      run_id: "run-1",
      phase: "selecting",
      inventory: [
        { path: "Docs/a.md", eligible: true, junk: false },
        { path: 7, eligible: true },
        "nope",
        { path: "Docs/conflict.md", eligible: "yes", junk: 1 },
      ],
    });
    assert.equal(doc?.run_id, "run-1");
    assert.deepEqual(doc?.inventory, [
      { path: "Docs/a.md", eligible: true, junk: false },
      { path: "Docs/conflict.md", eligible: false, junk: false },
    ]);
  });

  it("flattens proposal queues from items or grouped shapes, dropping unusable rows", () => {
    assert.deepEqual(flattenProposals(null), []);
    assert.deepEqual(
      flattenProposals({
        items: [
          { ref: "adoption:run-1:item-1", fingerprint: "fp-1", title: "Compile", kind: "compilation" },
          { ref: "adoption:run-1:item-2" },
        ],
      }),
      [{ ref: "adoption:run-1:item-1", fingerprint: "fp-1", title: "Compile", kind: "compilation" }]
    );
    assert.deepEqual(
      flattenProposals({
        groups: [
          { items: [{ ref: "a", fingerprint: "f", title: 4 }] },
          { items: [{ ref: "b", fingerprint: "g", kind: "relation" }] },
        ],
      }),
      [
        { ref: "a", fingerprint: "f", title: undefined, kind: undefined },
        { ref: "b", fingerprint: "g", title: undefined, kind: "relation" },
      ]
    );
  });

  it("extracts readable hits from an ask_memory response", () => {
    assert.deepEqual(answerHits(null), []);
    assert.deepEqual(
      answerHits({
        hits: [
          { title: "Trip notes", excerpt: "Pack light.", path: "Knowledge Base/trip.md" },
          { path: "Knowledge Base/other.md" },
          { excerpt: 9 },
        ],
      }),
      [
        { title: "Trip notes", excerpt: "Pack light.", path: "Knowledge Base/trip.md" },
        { title: undefined, excerpt: undefined, path: "Knowledge Base/other.md" },
      ]
    );
  });
});

describe("staging run slug", () => {
  it("generates slugs the upload route accepts and builds the staging path", () => {
    const slug = newStagingRunSlug();
    assert.match(slug, STAGING_RUN_SLUG);
    assert.notEqual(slug, newStagingRunSlug());
    assert.equal(stagingPathForRun(slug), `_Staging/adoption/${slug}`);
    assert.throws(() => stagingPathForRun("../escape"));
    assert.throws(() => stagingPathForRun(""));
  });

  it("shares the exact run-id pattern with the transfer grant validator", () => {
    // Same object, not a lookalike copy — the client slug and the server-side
    // upload-grant validation cannot drift apart.
    assert.equal(STAGING_RUN_SLUG, ADOPTION_RUN_ID);
  });
});

describe("stale-plan error routing", () => {
  it("maps ADOPTION_SOURCE_CHANGED and PLAN_STALE to an actionable notice", () => {
    const source = new HostedBrowserError(
      { code: "ADOPTION_SOURCE_CHANGED", message: "3 files changed after the scan." },
      409
    );
    assert.equal(
      staleNoticeFor(source),
      "Your files changed since we looked: 3 files changed after the scan."
    );
    const plan = new HostedBrowserError(
      { code: "PLAN_STALE", message: "The plan no longer matches the selection." },
      409
    );
    assert.equal(
      staleNoticeFor(plan),
      "Your files changed since we looked: The plan no longer matches the selection."
    );
  });

  it("returns null for every other failure so generic handling stays intact", () => {
    assert.equal(
      staleNoticeFor(new HostedBrowserError({ code: "REQUEST_FAILED", message: "nope" }, 500)),
      null
    );
    assert.equal(
      staleNoticeFor(new HostedBrowserError({ code: "REVIEW_ITEM_CHANGED", message: "drift" }, 409)),
      null
    );
    assert.equal(staleNoticeFor(new Error("plain")), null);
    assert.equal(staleNoticeFor(null), null);
  });
});

describe("junk totals", () => {
  it("trusts a present junk_counts map even when it legitimately sums to zero", () => {
    const base = {
      run_id: "run-1",
      phase: "selecting",
      inventory: [{ path: "conflict copy.md", eligible: false, junk: true }],
    };
    assert.equal(junkTotal({ ...base, scan_summary: { junk_counts: {} } }), 0);
    assert.equal(junkTotal({ ...base, scan_summary: { junk_counts: { empty: 0 } } }), 0);
    assert.equal(
      junkTotal({ ...base, scan_summary: { junk_counts: { empty: 0, conflict: 2 } } }),
      2
    );
    // Only a MISSING junk_counts map falls back to counting inventory rows.
    assert.equal(junkTotal(base), 1);
    assert.equal(junkTotal({ ...base, scan_summary: {} }), 1);
  });
});

describe("bounded-concurrency staging uploads", () => {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("caps in-flight uploads at the pool limit while reporting progress", async () => {
    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];
    const progress: [number, number][] = [];
    const resolvers: (() => void)[] = [];

    const batch = uploadBatch(
      [0, 1, 2, 3, 4, 5, 6],
      3,
      (item: number) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            active -= 1;
            completed.push(item);
            resolve();
          });
        });
      },
      (done, total) => progress.push([done, total])
    );

    await tick();
    assert.equal(resolvers.length, 3);
    resolvers[0]();
    await tick();
    assert.equal(resolvers.length, 4);
    while (resolvers.length > completed.length) {
      resolvers[completed.length]();
      await tick();
    }
    await batch;
    assert.equal(maxActive, 3);
    assert.deepEqual(completed.sort(), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(progress.length, 7);
    assert.deepEqual(progress.at(-1), [7, 7]);
  });

  it("attributes the failing item and starts nothing new after a failure", async () => {
    const started: number[] = [];
    const gates: { resolve: () => void; reject: (reason: Error) => void }[] = [];

    const batch = uploadBatch([0, 1, 2, 3, 4], 2, (item: number) => {
      started.push(item);
      return new Promise<void>((resolve, reject) => gates.push({ resolve, reject }));
    });

    await tick();
    assert.deepEqual(started, [0, 1]);
    gates[1].reject(new Error("boom"));
    await tick();
    gates[0].resolve();
    await assert.rejects(batch, (error: unknown) => {
      assert.equal(error instanceof BatchUploadError, true);
      const failure = error as BatchUploadError;
      assert.equal(failure.index, 1);
      assert.equal((failure.reason as Error).message, "boom");
      return true;
    });
    // The in-flight item settled, but no new upload started after the failure.
    assert.deepEqual(started, [0, 1]);
  });
});
