/**
 * The notes of a month's releases, and the identity the model and the
 * operator pick them by: the release version and the note's position in that
 * release's notes (`send-monthly-whats-new-digest`, D1 and D2).
 */

import { releaseVersion, compareReleaseVersions } from "../release-tag";

/** One change as its author wrote it: a short title (none on an older note) and one sentence. */
export type DigestNote = { title: string | null; text: string };

export type NoteId = { version: string; position: number };

/** A month's note with its identity, as the model reads it and the email shows it. */
export type MonthNote = NoteId & DigestNote;

export type ReleaseNotes = { version: string; releasedOn: string; notes: DigestNote[] };

export const noteKey = (id: NoteId): string => `${id.version}#${id.position}`;

export function versionTuple(version: string) {
  return releaseVersion(`v${version}`);
}

/** The notes file is read all or nothing, as the cell reads it: a partial list shown as the whole would hide changes. */
export type ParsedNotesFile =
  | { ok: true; release: ReleaseNotes | null }
  | { ok: false; reason: string };

const NOTES_FILE_SCHEMA = 2;

function isNonBlankText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** `YYYY-MM-DD` that names a real day. */
function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Reads one release's notes file. The format is Evermatter's, defined in its
 * `src/exomem/release_notes_format.py` (`parse_document`, `_release`, `_note`)
 * with at most one entry: the asset's own release, which must be
 * `expectedVersion`. A release with no notes has `"releases": []`.
 */
export function parseNotesFile(text: string, expectedVersion: string): ParsedNotesFile {
  let content: unknown;
  try {
    content = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const document = content as { schema?: unknown; releases?: unknown } | null;
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.schema !== NOTES_FILE_SCHEMA ||
    !Array.isArray(document.releases)
  ) {
    return { ok: false, reason: `not a schema ${NOTES_FILE_SCHEMA} notes file` };
  }
  if (document.releases.length === 0) return { ok: true, release: null };
  if (document.releases.length > 1)
    return { ok: false, reason: "more than the asset's own release" };
  const entry = document.releases[0] as Record<string, unknown> | null;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, reason: "a release is not an object" };
  }
  if (entry.version !== expectedVersion || !versionTuple(expectedVersion)) {
    return { ok: false, reason: "the release is not the asset's own" };
  }
  if (!isCanonicalDate(entry.released_on))
    return { ok: false, reason: "released_on is not YYYY-MM-DD" };
  if (!Array.isArray(entry.notes) || entry.notes.length === 0) {
    return { ok: false, reason: "the release has no notes" };
  }
  const notes: DigestNote[] = [];
  for (const raw of entry.notes) {
    const note = raw as Record<string, unknown> | null;
    const keys = note && typeof note === "object" && !Array.isArray(note) ? Object.keys(note) : [];
    if (
      !note ||
      keys.length !== 2 ||
      !keys.includes("title") ||
      !keys.includes("text") ||
      !isNonBlankText(note.text) ||
      !(note.title === null || isNonBlankText(note.title))
    ) {
      return { ok: false, reason: "a note is not an object with a title and a text" };
    }
    notes.push({ title: note.title as string | null, text: note.text });
  }
  return { ok: true, release: { version: expectedVersion, releasedOn: entry.released_on, notes } };
}

/** A month's notes in a stable order: newest release first, then the release's own order. */
export function monthNotes(releases: readonly ReleaseNotes[]): MonthNote[] {
  const ordered = [...releases].sort((a, b) => {
    const left = versionTuple(a.version);
    const right = versionTuple(b.version);
    return left && right ? compareReleaseVersions(right, left) : 0;
  });
  return ordered.flatMap((release) =>
    release.notes.map((note, position) => ({ version: release.version, position, ...note }))
  );
}

/** The notes the identifiers name, in the identifiers' order; `null` when any names no note of the month, or names one twice. */
export function resolveSelection(
  notes: readonly MonthNote[],
  selection: readonly NoteId[]
): MonthNote[] | null {
  const byKey = new Map(notes.map((note) => [noteKey(note), note]));
  const seen = new Set<string>();
  const resolved: MonthNote[] = [];
  for (const id of selection) {
    const key = noteKey(id);
    const note = byKey.get(key);
    if (!note || seen.has(key)) return null;
    seen.add(key);
    resolved.push(note);
  }
  return resolved;
}

/** An identifier as a request or a stored row gives it; anything else is `null`. */
export function parseNoteId(value: unknown): NoteId | null {
  const id = value as { version?: unknown; position?: unknown } | null;
  if (
    !id ||
    typeof id !== "object" ||
    typeof id.version !== "string" ||
    !versionTuple(id.version) ||
    typeof id.position !== "number" ||
    !Number.isSafeInteger(id.position) ||
    id.position < 0
  ) {
    return null;
  }
  return { version: id.version, position: id.position };
}

/** A list of identifiers as a request or a stored row gives it; `null` when any entry is not one. */
export function parseNoteIds(value: unknown): NoteId[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(parseNoteId);
  return ids.every((id): id is NoteId => id !== null) ? ids : null;
}
