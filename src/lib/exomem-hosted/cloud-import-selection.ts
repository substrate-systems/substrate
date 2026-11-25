import ignore, { type Ignore } from "ignore";
import type { ImportFile } from "./cloud-import-browser";
import { expandZip, isZipName, zipStem, type ZipLeftOutReason } from "./cloud-import-zip";

/** One thing the person chose or dropped. A folder's file paths are relative to the folder. */
export type PickedItem =
  | { kind: "file"; file: File }
  | { kind: "folder"; name: string; files: { path: string; file: File }[] };

/** Why a file the person chose is not sent; the preflight shows each beside the file. */
export type LeftOutReason = ZipLeftOutReason | "zip-unreadable" | "hidden" | "gitignored";
export type LeftOutFile = { path: string; bytes: number; reason: LeftOutReason };

/** A file of the selection and whether the default selection leaves it out, and why. */
export type FolderEntry = ImportFile & {
  hidden: boolean;
  gitignored: boolean;
  /** A .gitignore file too large to read as rules, so its rules are not applied. */
  rulesSkipped: boolean;
};

/** One pick as it enters the archive, under a top-level name that no other pick holds. */
export type SelectionPart = {
  /** The top-level archive name: the file's name, the folder's name or the zip's stem. */
  name: string;
  kind: "file" | "folder" | "zip";
  /** The name the person picked: the file's, the folder's or the zip file's own name. */
  source: string;
  entries: FolderEntry[];
  /** Files found unreadable while the pick was read, such as a zip's encrypted entries. */
  leftOut: LeftOutFile[];
  /** A loose file's identity, so the same file chosen twice is kept once. */
  identity: string | null;
};

/** Whether the person brought back the items the folder's own .gitignore files exclude. */
export type IncludeChoices = { gitignored: boolean };
export type SelectionTotals = { files: number; bytes: number };
export type ImportSelection = {
  files: ImportFile[];
  included: SelectionTotals;
  /** Every chosen file that is not sent, with its reason. */
  leftOut: LeftOutFile[];
  /** What the .gitignore files exclude, whether or not the person brought it back. */
  gitignored: SelectionTotals;
  /** .gitignore files whose rules are not applied, so the totals above leave nothing out for them. */
  skippedRules: number;
  parts: (Pick<SelectionPart, "name" | "kind" | "source"> & { included: SelectionTotals })[];
};

// git's per-directory exclude file, a name git itself fixes.
const GITIGNORE = ".gitignore";
// A larger .gitignore is not a rules file, and reading it whole could exhaust browser memory.
export const GITIGNORE_MAX_BYTES = 4 * 1024 * 1024;

function gitignoreFile(path: string): boolean {
  return path === GITIGNORE || path.endsWith(`/${GITIGNORE}`);
}

/** A dot-led name is hidden by Unix convention; a hidden folder hides everything inside it. */
function hiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function parent(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/**
 * Marks hidden items and the items the selection's own .gitignore files exclude, with git's
 * precedence: deeper files override shallower ones, and an excluded folder's rules never apply.
 */
export async function classifyFolder(files: ImportFile[]): Promise<FolderEntry[]> {
  const rules = new Map<string, Ignore>();
  for (const { path, file } of files) {
    if (gitignoreFile(path) && file.size <= GITIGNORE_MAX_BYTES)
      rules.set(parent(path), ignore().add(await new Response(file.stream()).text()));
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
    rulesSkipped: gitignoreFile(entry.path) && entry.file.size > GITIGNORE_MAX_BYTES,
  }));
}

/** The picks an input's files make: a folder picker's files share their first path component. */
export function pickedFromFiles(files: File[]): PickedItem[] {
  const items: PickedItem[] = [];
  const folders = new Map<string, { path: string; file: File }[]>();
  for (const file of files) {
    const [root, ...rest] = (file.webkitRelativePath || "").split("/");
    if (!root || !rest.length) {
      items.push({ kind: "file", file });
      continue;
    }
    let folder = folders.get(root);
    if (!folder) {
      folder = [];
      folders.set(root, folder);
      items.push({ kind: "folder", name: root, files: folder });
    }
    folder.push({ path: rest.join("/"), file });
  }
  return items;
}

/** The entries of a drop, taken while the drop event runs, as the browser requires. */
export function dropEntries(data: DataTransfer): FileSystemEntry[] | null {
  const items = Array.from(data.items ?? []).filter((item) => item.kind === "file");
  if (!items.length || typeof items[0].webkitGetAsEntry !== "function") return null;
  const entries = items.map((item) => item.webkitGetAsEntry());
  return entries.every((entry) => entry !== null) ? (entries as FileSystemEntry[]) : null;
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function folderFiles(
  folder: FileSystemDirectoryEntry,
  prefix: string,
  into: { path: string; file: File }[]
): Promise<void> {
  const reader = folder.createReader();
  // readEntries answers in batches until it answers with none.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (!batch.length) return;
    for (const entry of batch) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isFile) into.push({ path, file: await entryFile(entry as FileSystemFileEntry) });
      else if (entry.isDirectory)
        await folderFiles(entry as FileSystemDirectoryEntry, path, into);
    }
  }
}

/** The picks a drop makes: each dropped folder with every file inside it, and loose files. */
export async function pickedFromEntries(entries: FileSystemEntry[]): Promise<PickedItem[]> {
  const items: PickedItem[] = [];
  for (const entry of entries) {
    if (entry.isFile) items.push({ kind: "file", file: await entryFile(entry as FileSystemFileEntry) });
    else if (entry.isDirectory) {
      const files: { path: string; file: File }[] = [];
      await folderFiles(entry as FileSystemDirectoryEntry, "", files);
      items.push({ kind: "folder", name: entry.name, files });
    }
  }
  return items;
}

/** `name`, or `name (2)` and so on, before its extension, so it differs from every taken name. */
function freeName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let copy = 2; ; copy += 1) {
    const candidate = `${stem} (${copy})${extension}`;
    if (!taken(candidate)) return candidate;
  }
}

function fileIdentity(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

/** A folder's files under `folder/`, with each zip inside it expanded beside it. */
async function folderPart(
  folder: string,
  files: { path: string; file: File }[]
): Promise<Pick<SelectionPart, "entries" | "leftOut">> {
  const plain: ImportFile[] = [];
  const zips: { path: string; file: File }[] = [];
  for (const entry of files) {
    if (isZipName(entry.file.name)) zips.push(entry);
    else plain.push({ path: `${folder}/${entry.path}`, file: entry.file });
  }
  const leftOut: LeftOutFile[] = [];
  const taken = (path: string) =>
    plain.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`));
  for (const { path, file } of zips) {
    const where = parent(`${folder}/${path}`);
    const stem = freeName(zipStem(file.name), (name) => taken(`${where}/${name}`));
    const expanded = await expandZip(file, `${where}/${stem}`);
    if (expanded.readable) {
      plain.push(...expanded.members);
      leftOut.push(...expanded.leftOut);
    } else {
      leftOut.push({ path: `${folder}/${path}`, bytes: file.size, reason: "zip-unreadable" });
    }
  }
  return { entries: await classifyFolder(plain), leftOut };
}

/**
 * Adds picks to a selection. Each pick keeps a top-level name of its own: a folder its name, a
 * zip its stem and a file its name, with a number added when another pick holds that name. The
 * same loose file chosen again is kept once.
 */
export async function addToSelection(
  parts: SelectionPart[],
  items: PickedItem[]
): Promise<SelectionPart[]> {
  const next = [...parts];
  const taken = (name: string) => next.some((part) => part.name === name);
  for (const item of items) {
    if (item.kind === "folder") {
      if (!item.files.length) continue;
      const name = freeName(item.name, taken);
      next.push({
        name,
        kind: "folder",
        source: item.name,
        identity: null,
        ...(await folderPart(name, item.files)),
      });
      continue;
    }
    const identity = fileIdentity(item.file);
    if (next.some((part) => part.identity === identity)) continue;
    if (isZipName(item.file.name)) {
      const name = freeName(zipStem(item.file.name), taken);
      const expanded = await expandZip(item.file, name);
      next.push({
        name,
        kind: "zip",
        source: item.file.name,
        identity,
        ...(expanded.readable
          ? { entries: await classifyFolder(expanded.members), leftOut: expanded.leftOut }
          : {
              entries: [],
              leftOut: [{ path: item.file.name, bytes: item.file.size, reason: "zip-unreadable" }],
            }),
      });
      continue;
    }
    const name = freeName(item.file.name, taken);
    next.push({
      name,
      kind: "file",
      source: item.file.name,
      identity,
      entries: await classifyFolder([{ path: name, file: item.file }]),
      leftOut: [],
    });
  }
  return next;
}

/** The files to send under the person's choice, and every chosen file that stays out, with why. */
export function selectImportFiles(
  parts: SelectionPart[],
  include: IncludeChoices
): ImportSelection {
  const totals = () => ({ files: 0, bytes: 0 });
  const selection: ImportSelection = {
    files: [],
    included: totals(),
    leftOut: [],
    gitignored: totals(),
    skippedRules: 0,
    parts: [],
  };
  for (const part of parts) {
    const included = totals();
    selection.leftOut.push(...part.leftOut);
    for (const { path, file, hidden, gitignored, rulesSkipped } of part.entries) {
      if (rulesSkipped) selection.skippedRules += 1;
      const bytes = file.size;
      if (gitignored && !hidden) {
        selection.gitignored.files += 1;
        selection.gitignored.bytes += bytes;
      }
      // Each left-out file counts once, under the first reason that still leaves it out.
      const reason = hidden ? "hidden" : gitignored && !include.gitignored ? "gitignored" : null;
      if (reason) {
        selection.leftOut.push({ path, bytes, reason });
        continue;
      }
      included.files += 1;
      included.bytes += bytes;
      selection.files.push({ path, file });
    }
    selection.included.files += included.files;
    selection.included.bytes += included.bytes;
    selection.parts.push({ name: part.name, kind: part.kind, source: part.source, included });
  }
  return selection;
}

/**
 * The collection name the selection itself gives: one folder or one zip names its collection.
 * Loose files and mixed picks have none of their own.
 */
export function selectionCollection(parts: SelectionPart[]): string | null {
  return parts.length === 1 && parts[0].kind !== "file" ? parts[0].name : null;
}
