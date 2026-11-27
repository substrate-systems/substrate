import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReleaseVersion, selectWhatsNew, type WhatsNewRelease } from "../cloud-home-whats-new";

const release = (version: string, released_on: string, ...notes: string[]): WhatsNewRelease => ({
  version,
  released_on,
  notes: notes.map((text) => ({ title: null, text })),
});
const versions = (releases: WhatsNewRelease[]) => releases.map((entry) => entry.version);

describe("which release notes Home shows", () => {
  it("shows what arrived after the dismissal, up to the running version, newest first", () => {
    const shown = selectWhatsNew({
      running: "1.3.0",
      dismissed: "1.2.0",
      cellCreatedOn: "2026-01-01",
      releases: [
        release("1.4.0", "2026-11-26", "Not running yet."),
        release("1.2.0", "2026-11-10", "Already seen."),
        release("1.3.0", "2026-11-20", "A new note."),
      ],
    });
    assert.deepEqual(versions(shown), ["1.3.0"]);
  });

  it("orders versions by number, not by text", () => {
    const shown = selectWhatsNew({
      running: "1.10.0",
      dismissed: "1.1.0",
      cellCreatedOn: "2026-01-01",
      releases: [
        release("1.9.0", "2026-11-01", "Nine."),
        release("1.2.0", "2026-10-01", "Two."),
        release("1.10.0", "2026-11-02", "Ten."),
        release("1.1.0", "2026-09-01", "Seen."),
      ],
    });
    assert.deepEqual(versions(shown), ["1.10.0", "1.9.0", "1.2.0"]);
  });

  it("shows only releases after the creation day before a first dismissal", () => {
    const shown = selectWhatsNew({
      running: "1.3.0",
      dismissed: null,
      cellCreatedOn: "2026-11-20",
      releases: [
        release("1.1.0", "2026-11-19", "Before the cell."),
        release("1.2.0", "2026-11-20", "On the day the cell was made."),
        release("1.3.0", "2026-11-21", "After the cell was made."),
      ],
    });
    assert.deepEqual(versions(shown), ["1.3.0"]);
  });

  it("ignores the creation day once the owner has dismissed", () => {
    const shown = selectWhatsNew({
      running: "1.3.0",
      dismissed: "1.0.0",
      cellCreatedOn: "2026-11-20",
      releases: [
        release("1.1.0", "2026-11-01", "Dated before the cell, newer than the dismissal."),
      ],
    });
    assert.deepEqual(versions(shown), ["1.1.0"]);
  });

  it("shows no release that has no note, and no release of an unreadable version", () => {
    const shown = selectWhatsNew({
      running: "1.3.0",
      dismissed: "1.0.0",
      cellCreatedOn: "2026-01-01",
      releases: [
        release("1.1.0", "2026-11-01"),
        release("1.2.0", "2026-11-02", "  "),
        release("not-a-version", "2026-11-03", "A note."),
        release("1.3.0", "2026-11-04", "A note.", ""),
      ],
    });
    assert.deepEqual(shown, [release("1.3.0", "2026-11-04", "A note.")]);
  });

  it("shows nothing when the running version is not a release", () => {
    assert.deepEqual(
      selectWhatsNew({
        running: "dev",
        dismissed: null,
        cellCreatedOn: "2026-01-01",
        releases: [release("1.0.0", "2026-11-01", "A note.")],
      }),
      []
    );
  });
});

describe("which versions a dismissal may store", () => {
  it("admits only a plain release version", () => {
    assert.equal(isReleaseVersion("1.3.0"), true);
    for (const refused of ["", "1.3", "v1.3.0", "1.3.0-rc1", "01.3.0", "1.3.0 ", "1.3.x"]) {
      assert.equal(isReleaseVersion(refused), false, refused);
    }
  });
});
