import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFolder, selectImportFiles } from "../cloud-import-selection";

function entry(path: string, body = "x") {
  return { path, file: new File([body], path.split("/").at(-1)!) };
}

test("hidden items and the folder's own .gitignore rules stay out by default, per reason, until brought back", async () => {
  const folder = await classifyFolder([
    entry(".gitignore", "build/\n*.log\n"),
    entry("notes/plan.md", "plan"),
    entry("notes/today.log", "log line"),
    entry("build/out.js", "bundle"),
    // An excluded folder's own rules never apply, so this negation re-includes nothing.
    entry("build/.gitignore", "!keep.js\n"),
    entry("build/keep.js", "kept?"),
    // A deeper .gitignore overrides a shallower one, including by negation.
    entry("drafts/.gitignore", "*\n!keep.md\n"),
    entry("drafts/scratch.md", "scratch"),
    entry("drafts/keep.md", "keep"),
    entry(".cache/index", "cache"),
    // Hidden and matched by .gitignore: counted once, under the first reason that applies.
    entry(".env.log", "secret-shaped"),
  ]);

  const byDefault = selectImportFiles(folder, { hidden: false, gitignored: false });
  assert.deepEqual(
    byDefault.files.map(({ path }) => path),
    ["notes/plan.md", "drafts/keep.md"]
  );
  assert.deepEqual(byDefault.included, { files: 2, bytes: 8 });
  // .gitignore, build/.gitignore, drafts/.gitignore, .cache/index, .env.log
  assert.deepEqual(byDefault.excluded.hidden, { files: 5, bytes: 51 });
  // notes/today.log, build/out.js, build/keep.js, drafts/scratch.md
  assert.deepEqual(byDefault.excluded.gitignored, { files: 4, bytes: 26 });

  const withHidden = selectImportFiles(folder, { hidden: true, gitignored: false });
  assert.ok(!withHidden.files.some(({ path }) => path === ".env.log"));
  assert.ok(withHidden.files.some(({ path }) => path === ".cache/index"));
  assert.deepEqual(withHidden.excluded.hidden, { files: 0, bytes: 0 });
  // Now also: build/.gitignore (inside excluded build/), drafts/.gitignore (its own *) and
  // .env.log (*.log).
  assert.deepEqual(withHidden.excluded.gitignored, { files: 7, bytes: 59 });

  const everything = selectImportFiles(folder, { hidden: true, gitignored: true });
  assert.equal(everything.files.length, folder.length);
});
