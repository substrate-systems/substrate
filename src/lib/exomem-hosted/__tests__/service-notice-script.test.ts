import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeIssueFor,
  type DescribedNotice,
  issueNumberFor,
  NoStatusIssueError,
  noticeMarker,
  statusIssueFor,
} from "../../../../scripts/exomem-service-notice";

// The public status page reads a maintenance issue's body with its own parser, which
// this repository does not hold. This is a faithful copy of the part that matters: it
// takes the first `<!-- -->` of the body and reads `key: value` lines from it, as
// Upptime's status site does. A body it cannot read would leave the maintenance off the
// page, which only shows up when someone looks at the page.
function statusSiteMetadata(body: string): Record<string, string> {
  const block = body.split("<!--")[1]?.split("-->")[0];
  assert.ok(block !== undefined, "the body has no metadata block");
  const metadata: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (!line.includes(":")) continue;
    const [key, value] = line.split(/:(.+)/);
    if (key && value) metadata[key.trim()] = value.trim();
  }
  return metadata;
}

const NOTICE_ID = "5b3c1d52-7f4a-4c2e-9d0e-2a1f8b6c4e10";

describe("the status issue for a notice", () => {
  const maintenance = {
    id: NOTICE_ID,
    kind: "maintenance" as const,
    summary: "We are moving storage.",
    startsAt: "2026-12-01T02:00:00.000Z",
    endsAt: "2026-12-01T02:30:00.000Z",
  };

  it("gives maintenance a body the status site reads, with the times and the affected lines", () => {
    const issue = statusIssueFor(maintenance, ["website-and-sign-in", "your-exomem"]);
    assert.deepEqual(issue.labels, ["maintenance"]);
    assert.equal(issue.title, "We are moving storage.");
    assert.deepEqual(statusSiteMetadata(issue.body), {
      start: "2026-12-01T02:00:00.000Z",
      end: "2026-12-01T02:30:00.000Z",
      expectedDown: "website-and-sign-in, your-exomem",
    });
  });

  it("leaves expectedDown out when the operator names no line, rather than writing an empty one", () => {
    const metadata = statusSiteMetadata(statusIssueFor(maintenance, []).body);
    assert.deepEqual(Object.keys(metadata), ["start", "end"]);
  });

  it("labels an incident status plus the affected line, with no times for the site to misread", () => {
    const issue = statusIssueFor(
      { ...maintenance, kind: "incident", summary: "Saving is slow.", endsAt: null },
      ["your-exomem"]
    );
    assert.deepEqual(issue.labels, ["status", "your-exomem"]);
    assert.equal(issue.title, "Saving is slow.");
    assert.ok(!issue.body.includes("start:"));
  });

  it("names the notice by its id and nothing about a tenant or a cell", () => {
    // The route's own description of a notice carries its cells; the issue must not.
    const described: DescribedNotice = {
      ...maintenance,
      state: "scheduled",
      say: "Exomem maintenance is planned.",
      cellIds: ["aaaaaaaaaaaaaaaa"],
    };
    const issue = statusIssueFor(described, []);
    assert.ok(issue.body.includes(noticeMarker(NOTICE_ID)));
    assert.ok(!JSON.stringify(issue).includes("aaaaaaaaaaaaaaaa"));
    assert.ok(!JSON.stringify(issue).includes("planned"), "the assistant's sentence stays out");
  });

  it("finds the issue that mirrors a notice, and not another notice's", () => {
    const issues = [
      { number: 7, body: statusIssueFor({ ...maintenance, id: "other" }, []).body },
      { number: 9, body: statusIssueFor(maintenance, []).body },
    ];
    assert.equal(issueNumberFor(issues, NOTICE_ID), 9);
    assert.equal(issueNumberFor(issues, "missing"), null);
  });
});

describe("closing the status issue", () => {
  const incident = { id: NOTICE_ID, kind: "incident" as const };
  const issue = {
    number: 42,
    body: statusIssueFor({ ...incident, summary: "s", startsAt: "t", endsAt: null }, []).body,
  };

  /** A stand-in `gh` that answers each list by state and records every command. */
  function fakeGh(lists: { open: unknown[]; closed: unknown[] }) {
    const commands: string[][] = [];
    const run = async (args: string[]) => {
      commands.push(args);
      if (args[1] === "list")
        return JSON.stringify(lists[args[args.indexOf("--state") + 1] as "open" | "closed"]);
      return "";
    };
    return { run, commands };
  }

  it("closes the open issue with the operator's account", async () => {
    const { run, commands } = fakeGh({ open: [issue], closed: [] });
    const result = await closeIssueFor(incident, "A bad deploy.", "completed", run);
    assert.deepEqual(result, { ref: "substrate-systems/exomem-status#42", alreadyClosed: false });
    const close = commands.find((args) => args[1] === "close");
    assert.deepEqual(close?.slice(2, 3), ["42"]);
    assert.ok(close?.includes("A bad deploy."));
  });

  it("comments on an issue the status monitor already closed, instead of failing", async () => {
    const { run, commands } = fakeGh({ open: [], closed: [issue] });
    const result = await closeIssueFor(incident, "A bad deploy.", "completed", run);
    assert.deepEqual(result, { ref: "substrate-systems/exomem-status#42", alreadyClosed: true });
    assert.equal(
      commands.some((args) => args[1] === "close"),
      false
    );
    const comment = commands.find((args) => args[1] === "comment");
    assert.ok(comment?.includes("A bad deploy."));
  });

  it("still fails when no issue, open or closed, carries the notice's marker", async () => {
    const { run } = fakeGh({ open: [], closed: [] });
    await assert.rejects(
      closeIssueFor(incident, "A bad deploy.", "completed", run),
      (error: unknown) =>
        error instanceof NoStatusIssueError &&
        error.message === "no status issue carries this notice's marker"
    );
  });
});
