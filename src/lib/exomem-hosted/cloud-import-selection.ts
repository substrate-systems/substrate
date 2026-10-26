import ignore, { type Ignore } from "ignore";
import type { ImportFile } from "./cloud-import-browser";

/** A picked file and whether the default selection leaves it out, and why. */
export type FolderEntry = ImportFile & { hidden: boolean; gitignored: boolean };
/** Which kinds of left-out items the person chose to bring in after all. */
export type IncludeChoices = { hidden: boolean; gitignored: boolean };
export type SelectionTotals = { files: number; bytes: number };
export type ImportSelection = {
  files: ImportFile[];
  included: SelectionTotals;
  /** Each left-out file counts once, under the first reason that still leaves it out. */
  excluded: { hidden: SelectionTotals; gitignored: SelectionTotals };
};

// git's per-directory exclude file, a name git itself fixes.
const GITIGNORE = ".gitignore";

/** A dot-led name is hidden by Unix convention; a hidden folder hides everything inside it. */
function hiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function parent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Marks hidden items and the items the folder's own .gitignore files exclude, with git's
 * precedence: deeper files override shallower ones, and an excluded folder's rules never apply.
 */
export async function classifyFolder(files: ImportFile[]): Promise<FolderEntry[]> {
  const rules = new Map<string, Ignore>();
  for (const { path, file } of files) {
    if (path === GITIGNORE || path.endsWith(`/${GITIGNORE}`))
      rules.set(parent(path), ignore().add(await file.text()));
  }
  const matched = (path: string, directory: boolean): boolean => {
    const parts = path.split("/");
    let excluded = false;
    for (let depth = 0; depth < parts.length; depth += 1) {
      const matcher = rules.get(parts.slice(0, depth).join("/"));
      if (!matcher) continue;
      const verdict = matcher.test(parts.slice(depth).join("/") + (directory ? "/" : ""));
      if (verdict.ignored) excluded = true;
      else if (verdict.unignored) excluded = false;
    }
    return excluded;
  };
  const folders = new Map<string, boolean>();
  const folderExcluded = (path: string): boolean => {
    if (!path) return false;
    let excluded = folders.get(path);
    if (excluded === undefined) {
      excluded = folderExcluded(parent(path)) || matched(path, true);
      folders.set(path, excluded);
    }
    return excluded;
  };
  return files.map((entry) => ({
    ...entry,
    hidden: hiddenPath(entry.path),
    gitignored:
      rules.size > 0 && (folderExcluded(parent(entry.path)) || matched(entry.path, false)),
  }));
}

/** The files to import under the person's choices, with totals for what stays out. */
export function selectImportFiles(
  entries: FolderEntry[],
  include: IncludeChoices
): ImportSelection {
  const totals = () => ({ files: 0, bytes: 0 });
  const selection: ImportSelection = {
    files: [],
    included: totals(),
    excluded: { hidden: totals(), gitignored: totals() },
  };
  for (const { path, file, hidden, gitignored } of entries) {
    const bucket =
      hidden && !include.hidden
        ? selection.excluded.hidden
        : gitignored && !include.gitignored
          ? selection.excluded.gitignored
          : selection.included;
    bucket.files += 1;
    bucket.bytes += file.size;
    if (bucket === selection.included) selection.files.push({ path, file });
  }
  return selection;
}
