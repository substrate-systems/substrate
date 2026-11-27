import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monthNotes, parseNotesFile, resolveSelection } from "../notes";

// Both files are Evermatter's own output: `release_notes_format.document()` from its
// `src/exomem/release_notes_format.py`, printed as JSON, not a shape derived from this validator.
const WITH_NOTES =
  '{"schema": 2, "releases": [{"version": "1.4.2", "released_on": "2026-11-12", "notes": [{"title": "Faster search", "text": "Search answers in about half the time on large memories."}, {"title": null, "text": "The assistant now says when a memory was last changed."}]}]}';
const NO_NOTES = '{"schema": 2, "releases": []}';

describe("the release notes file", () => {
  it("reads a release's notes, an untitled note keeping a null title", () => {
    const parsed = parseNotesFile(WITH_NOTES, "1.4.2");
    assert.ok(parsed.ok && parsed.release);
    assert.deepEqual(parsed.release.notes, [
      { title: "Faster search", text: "Search answers in about half the time on large memories." },
      { title: null, text: "The assistant now says when a memory was last changed." },
    ]);
  });

  it("reads a release with no notes as no notes", () => {
    assert.deepEqual(parseNotesFile(NO_NOTES, "1.4.2"), { ok: true, release: null });
  });

  const unreadable: Array<[string, string]> = [
    ["a note keyed `sentence`", WITH_NOTES.replaceAll('"text"', '"sentence"')],
    ["an older schema", WITH_NOTES.replace('"schema": 2', '"schema": 1')],
    ["an extra key on a note", WITH_NOTES.replace('"title": null,', '"title": null, "id": 3,')],
    [
      "a blank sentence",
      WITH_NOTES.replace("The assistant now says when a memory was last changed.", "  "),
    ],
    ["another release's file", WITH_NOTES.replace('"version": "1.4.2"', '"version": "1.4.3"')],
    ["a date that is not a day", WITH_NOTES.replace("2026-11-12", "2026-11-31")],
    [
      "two releases",
      WITH_NOTES.replace(
        "]}]}",
        "]}, " + WITH_NOTES.slice(WITH_NOTES.indexOf('{"version"'), -2) + "]}"
      ),
    ],
    [
      "a release with an empty notes list",
      WITH_NOTES.replace(/"notes": \[.*\]\}\]\}/, '"notes": []}]}'),
    ],
    ["text that is not JSON", "<html>rate limited</html>"],
  ];
  for (const [name, text] of unreadable) {
    it(`reads ${name} as unreadable, not as no notes`, () => {
      assert.equal(parseNotesFile(text, "1.4.2").ok, false);
    });
  }
});

describe("a month's notes", () => {
  const release = (version: string, texts: string[]) => ({
    version,
    releasedOn: "2026-11-12",
    notes: texts.map((text) => ({ title: null, text })),
  });

  it("numbers each note by its place in its own release, newest release first", () => {
    const notes = monthNotes([release("1.4.9", ["a"]), release("1.10.0", ["b", "c"])]);
    assert.deepEqual(
      notes.map((note) => `${note.version}#${note.position}:${note.text}`),
      ["1.10.0#0:b", "1.10.0#1:c", "1.4.9#0:a"]
    );
  });

  it("refuses a selection that names a note twice or a note the month does not have", () => {
    const notes = monthNotes([release("1.4.9", ["a", "b"])]);
    assert.equal(
      resolveSelection(notes, [
        { version: "1.4.9", position: 0 },
        { version: "1.4.9", position: 0 },
      ]),
      null
    );
    assert.equal(resolveSelection(notes, [{ version: "1.4.9", position: 5 }]), null);
    assert.deepEqual(
      resolveSelection(notes, [
        { version: "1.4.9", position: 1 },
        { version: "1.4.9", position: 0 },
      ])?.map((note) => note.text),
      ["b", "a"]
    );
  });
});
