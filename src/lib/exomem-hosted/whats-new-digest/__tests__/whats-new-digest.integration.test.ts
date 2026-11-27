import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { GET as cronGet } from "../../../../app/api/cron/whats-new-digest/route";
import {
  GET as adminGet,
  POST as adminPost,
} from "../../../../app/api/exomem/admin/whats-new-digest/route";
import { openIsolatedSchema } from "./db-harness";
import {
  notesFile,
  startGitHub,
  startModel,
  type GitHubStandIn,
  type ModelStandIn,
  type StandInRelease,
} from "./stand-ins";
import type { DigestOverview, MonthDetail } from "../approval";
import { monthStart } from "../github";
import { WHATS_NEW_PROMPT_VERSION } from "../model";
import { previousMonth, runWhatsNewDigestSelection } from "../run";

// The monthly selection against real PostgreSQL, a stand-in GitHub server and a stand-in model
// endpoint over HTTP. The first suite is the daily route's whole workflow on the real clock; the
// second drives the branches that need a particular month.

process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");
const ADMIN_TOKEN = randomBytes(32).toString("base64url");
const CRON_SECRET = randomBytes(32).toString("base64url");
const GITHUB_TOKEN = "read-only-token";
const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;

const ENV_KEYS = [
  "EXOMEM_ADMIN_TOKEN",
  "CRON_SECRET",
  "EXOMEM_WHATS_NEW_GITHUB_API_URL",
  "EXOMEM_WHATS_NEW_GITHUB_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "EXOMEM_WHATS_NEW_MODEL",
  "EXOMEM_WHATS_NEW_FIRST_MONTH",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

const note = (title: string | null, text: string) => ({ title, text });
const id = (version: string, position: number) => ({ version, position });

/** What the admin route answers: the production types of the month and the overview, or an error's code. */
type Answer = { month: MonthDetail; overview: DigestOverview; error: { code: string } };

async function admin(method: "GET" | "POST", payload?: Record<string, unknown>, query = "") {
  const url = `https://substratesystems.io/api/exomem/admin/whats-new-digest${query}`;
  const request = new NextRequest(url, {
    method,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const response = await (method === "GET" ? adminGet(request) : adminPost(request));
  return { status: response.status, body: (await response.json()) as Answer };
}

const detail = async (month: string): Promise<MonthDetail> =>
  (await admin("GET", undefined, `?month=${month}`)).body.month;
const overview = async (): Promise<DigestOverview> => (await admin("GET")).body.overview;
const act = (payload: Record<string, unknown>) => admin("POST", payload);

describe("the monthly selection, through the daily route", { skip: !databaseUrl }, () => {
  const target = previousMonth(new Date());
  const start = monthStart(target);
  const nextStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const day = (d: number) =>
    new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), d, 12)).toISOString();
  const lastSecond = new Date(nextStart.getTime() - 1000).toISOString();
  const beforeStart = new Date(start.getTime() - 1000).toISOString();

  // Evermatter's own output for a release with two notes and one untitled (verbatim, from its writer).
  const release142 =
    '{"schema": 2, "releases": [{"version": "1.4.2", "released_on": "2026-11-12", "notes": [{"title": "Faster search", "text": "Search answers in about half the time on large memories."}, {"title": null, "text": "The assistant now says when a memory was last changed."}]}]}';
  const noNotes = '{"schema": 2, "releases": []}';
  const release140Notes = [
    note("Dark mode for emails", "Emails from Evermatter follow your device's dark setting."),
    note("Pin a memory", "Pinned memories stay at the top of search results."),
  ];

  const filler: StandInRelease[] = Array.from({ length: 104 }, (_, index) => {
    const stamp = new Date(nextStart.getTime() + index * 60_000).toISOString();
    return { version: `9.0.${index}`, createdAt: stamp, publishedAt: stamp };
  });
  const releases: StandInRelease[] = [
    ...filler,
    {
      version: "1.5.0",
      createdAt: lastSecond,
      publishedAt: lastSecond,
      file: notesFile("1.5.0", day(28).slice(0, 10), [
        note(
          "Share a memory by link",
          "Anyone with the link can read a shared memory until you turn it off."
        ),
        note(null, "Imports show how many notes they have read."),
        note("Quieter alerts", "Alerts group into one message per hour."),
      ]),
    },
    { version: "1.4.2", createdAt: day(12), publishedAt: day(12), file: release142 },
    { version: "1.4.1", createdAt: day(12), publishedAt: day(12), file: noNotes },
    // Attached later: the release that is missing its notes on the first day.
    { version: "1.4.0", createdAt: day(3), publishedAt: day(3) },
    {
      version: "1.4.3",
      createdAt: day(15),
      publishedAt: day(15),
      prerelease: true,
      file: notesFile("1.4.3", day(15).slice(0, 10), [note(null, "PRERELEASE NOTE")]),
    },
    {
      version: "1.4.5",
      createdAt: day(20),
      publishedAt: null,
      file: notesFile("1.4.5", day(20).slice(0, 10), [note(null, "DRAFT NOTE")]),
    },
    {
      version: "1.3.9",
      createdAt: beforeStart,
      publishedAt: beforeStart,
      file: notesFile("1.3.9", beforeStart.slice(0, 10), [note(null, "OLD NOTE")]),
    },
  ];

  let github: GitHubStandIn;
  let model: ModelStandIn;
  let database: Awaited<ReturnType<typeof openIsolatedSchema>>;

  const runRoute = async (secret: string | null = CRON_SECRET) => {
    const response = await cronGet(
      new NextRequest("https://substratesystems.io/api/cron/whats-new-digest", {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      })
    );
    return {
      status: response.status,
      body: (await response.json()) as { month: string; state: string; missingReleases: number },
    };
  };

  before(async () => {
    github = await startGitHub(releases);
    model = await startModel();
    process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
    // The first month the route builds: long before every month these suites use.
    process.env.EXOMEM_WHATS_NEW_FIRST_MONTH = "2000-01";
    process.env.CRON_SECRET = CRON_SECRET;
    process.env.EXOMEM_WHATS_NEW_GITHUB_API_URL = github.origin;
    process.env.EXOMEM_WHATS_NEW_GITHUB_TOKEN = GITHUB_TOKEN;
    process.env.ANTHROPIC_BASE_URL = model.origin;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.EXOMEM_WHATS_NEW_MODEL;
    database = await openIsolatedSchema("whats_new_route", databaseUrl!);
  });

  after(async () => {
    restoreEnv();
    await database?.close();
    await github?.close();
    await model?.close();
  });

  const modelPick = [id("1.4.2", 0), id("1.5.0", 0), id("1.4.0", 0)];
  const blindPick = [id("1.5.0", 0), id("1.4.2", 0), id("1.5.0", 2)];

  it("refuses the route without the scheduler secret and builds nothing", async () => {
    assert.equal((await runRoute(null)).status, 401);
    assert.equal((await runRoute("not-the-secret")).status, 401);
    const { rows } = await database.pool.query(
      "SELECT count(*)::int AS n FROM exomem_whats_new_digest_months"
    );
    assert.equal(rows[0].n, 0);
  });

  it("waits while a release has no notes file, names it, and calls no model", async () => {
    const run = await runRoute();
    assert.equal(run.status, 200);
    assert.deepEqual(
      [run.body.month, run.body.state, run.body.missingReleases],
      [target, "waiting_for_notes", 1]
    );

    const month = await detail(target);
    assert.deepEqual(
      month.releases.missing.map((r) => [r.version, r.problem]),
      [["1.4.0", "no_asset"]]
    );
    assert.deepEqual(month.notes, []);
    assert.equal(month.model, null);
    assert.equal(model.requests.length, 0);

    // The month's releases are those published in its UTC month: not the month after, the month
    // before, a draft or a prerelease. The list is read across its pages.
    assert.ok(github.requests.some((r) => r.url.includes("page=2")));
    assert.deepEqual(
      ["1.5.0", "1.4.2", "1.4.1"].map((version) => github.assetDownloads(version)),
      [1, 1, 1]
    );
    for (const version of ["1.4.3", "1.4.5", "1.3.9", "9.0.0"])
      assert.equal(github.assetDownloads(version), 0, version);
    // The read-only token goes to the API, and not along the redirect to storage.
    const api = github.requests.filter((r) => !r.url.startsWith("storage "));
    assert.ok(api.every((r) => r.headers.authorization === `Bearer ${GITHUB_TOKEN}`));
    assert.ok(
      github.requests
        .filter((r) => r.url.startsWith("storage "))
        .every((r) => r.headers.authorization === undefined)
    );
  });

  it("tries the missing release again the next day, fetches only that file, and waits in 'model not configured'", async () => {
    github.releases.find((r) => r.version === "1.4.0")!.file = notesFile(
      "1.4.0",
      day(3).slice(0, 10),
      release140Notes
    );
    const run = await runRoute();
    assert.deepEqual([run.body.state, run.body.missingReleases], ["waiting_for_model", 0]);
    // A fetched file is kept with the month and never fetched again.
    assert.deepEqual(
      ["1.5.0", "1.4.2", "1.4.1", "1.4.0"].map((version) => github.assetDownloads(version)),
      [1, 1, 1, 1]
    );

    const month = await detail(target);
    assert.equal(month.modelStatus, "not_configured");
    assert.equal(month.notes.length, 7);
    assert.equal((await overview()).modelConfigured, false);
    assert.equal(model.requests.length, 0);
  });

  it("leaves the month waiting through an outage, after one retry", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    model.answers.push({ status: 500 }, { status: 529 });
    const run = await runRoute();
    assert.equal(run.body.state, "waiting_for_model");
    assert.equal((await detail(target)).modelStatus, "unavailable");

    assert.equal(model.requests.length, 2);
    const first = model.requests[0];
    assert.equal(first.headers["x-api-key"], "test-key");
    assert.equal(first.headers["anthropic-version"], "2026-10-21");
    assert.equal(first.json.model, "claude-haiku-5-5");
    assert.equal(
      (first.json.output_config as { format: { type: string } }).format.type,
      "json_schema"
    );
    assert.equal("temperature" in first.json, false);
    const prompt = JSON.stringify(first.json.messages);
    assert.ok(prompt.includes("Pinned memories stay at the top of search results."));
    for (const excluded of ["PRERELEASE NOTE", "DRAFT NOTE", "OLD NOTE"])
      assert.ok(!prompt.includes(excluded), excluded);
  });

  it("ranks the month on the next run and takes the operator's pick before it shows the ranking", async () => {
    model.requests.length = 0;
    model.answers.push({ picks: modelPick });
    const run = await runRoute();
    assert.equal(run.body.state, "awaiting_approval");
    assert.equal(model.requests.length, 1);

    const month = await detail(target);
    // The identity of the ranking: the configured name, the model the API reported, the prompt's hash.
    assert.deepEqual(
      [month.modelId, month.modelReported, month.promptVersion],
      ["claude-haiku-5-5", "claude-haiku-5-5", WHATS_NEW_PROMPT_VERSION]
    );
    // Before the operator's own pick, neither the ranking nor an email built from it is on the page.
    assert.deepEqual(
      [month.canPickBlind, month.model, month.email, month.finalSelection],
      [true, null, null, null]
    );

    const early = await act({ action: "approve", month: target });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, "WHATS_NEW_DIGEST_BLIND_PICK_FIRST");
    assert.equal((await detail(target)).state, "awaiting_approval");
  });

  it("shows the ranking, the notes left out and the email in light and dark once the blind pick is recorded", async () => {
    const picked = await act({ action: "blind_pick", month: target, selection: blindPick });
    assert.equal(picked.status, 200);
    const month = picked.body.month;
    assert.deepEqual(
      month.model?.selection.map((n) => `${n.version}#${n.position}`),
      ["1.4.2#0", "1.5.0#0", "1.4.0#0"]
    );
    assert.equal(
      month.model?.selection[0].text,
      "Search answers in about half the time on large memories."
    );
    assert.equal(month.model?.leftOut.length, 4);
    assert.equal(month.email?.subject.startsWith("What's new in Evermatter"), true);
    assert.ok(
      month.email?.light.includes("Search answers in about half the time on large memories.")
    );
    assert.ok(month.email?.dark.includes("Share a memory by link"));

    // The pick is the answer key: it is taken once.
    const again = await act({
      action: "blind_pick",
      month: target,
      selection: [id("1.4.2", 0), id("1.5.0", 1), id("1.5.0", 2)],
    });
    assert.equal(again.status, 409);
    assert.deepEqual((await detail(target)).blindPick, blindPick);
  });

  it("stores an approved month as ready to queue, once, and a repeat run changes nothing", async () => {
    const approved = await act({ action: "approve", month: target });
    assert.equal(approved.status, 200);
    assert.deepEqual(
      [approved.body.month.state, approved.body.month.decision],
      ["ready_to_queue", "approved"]
    );
    assert.deepEqual(
      approved.body.month.finalSelection?.map((n) => `${n.version}#${n.position}`),
      ["1.4.2#0", "1.5.0#0", "1.4.0#0"]
    );

    const downloads = github.requests.length;
    model.requests.length = 0;
    const repeat = await runRoute();
    assert.equal(repeat.body.state, "ready_to_queue");
    assert.equal(model.requests.length, 0);
    assert.equal(github.requests.length, downloads);

    // Two of the operator's three picks are in the model's: two thirds, which passes.
    const run = (await overview()).measurement.run;
    assert.deepEqual(
      run.map((s) => [s.month, s.both, s.operatorPicks, s.passes]),
      [[target, 2, 3, true]]
    );
  });
});

describe("the monthly selection's branches", { skip: !databaseUrl }, () => {
  let github: GitHubStandIn;
  let model: ModelStandIn;
  let database: Awaited<ReturnType<typeof openIsolatedSchema>>;
  let versionCounter = 0;

  /** Publishes a release of `month` with the given notes (`null`: no notes asset). Returns its version. */
  function publish(month: string, notes: ReturnType<typeof note>[] | null | "unreadable"): string {
    versionCounter += 1;
    const version = `${versionCounter}.0.0`;
    const stamp = `${month}-15T12:00:00.000Z`;
    const file =
      notes === null
        ? undefined
        : notes === "unreadable"
          ? '{"schema": 1, "releases": [{"version": "' +
            version +
            '", "notes": ["a bare string"]}]}'
          : notesFile(version, stamp.slice(0, 10), notes);
    github.releases.push({ version, createdAt: stamp, publishedAt: stamp, file });
    return version;
  }

  const nextMonth = (month: string) => {
    const [year, number] = month.split("-").map(Number);
    return new Date(Date.UTC(year, number, 2, 6)); // the 2nd, 06:00 UTC, of the month after
  };
  const build = (month: string) =>
    runWhatsNewDigestSelection({ now: nextMonth(month), retryDelayMs: 0 });
  const three = (version: string) => [id(version, 0), id(version, 1), id(version, 2)];
  const threeNotes = () => [
    note("One", "First change."),
    note(null, "Second change."),
    note("Three", "Third change."),
  ];

  before(async () => {
    github = await startGitHub([]);
    model = await startModel();
    process.env.EXOMEM_ADMIN_TOKEN = ADMIN_TOKEN;
    // The first month the route builds: long before every month these suites use.
    process.env.EXOMEM_WHATS_NEW_FIRST_MONTH = "2000-01";
    process.env.EXOMEM_WHATS_NEW_GITHUB_API_URL = github.origin;
    delete process.env.EXOMEM_WHATS_NEW_GITHUB_TOKEN;
    process.env.ANTHROPIC_BASE_URL = model.origin;
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.EXOMEM_WHATS_NEW_MODEL;
    database = await openIsolatedSchema("whats_new_branches", databaseUrl!);
  });

  after(async () => {
    restoreEnv();
    await database?.close();
    await github?.close();
    await model?.close();
  });

  it("builds nothing before the configured first month, and the approval page says so", async () => {
    const built = async (month: string) =>
      (
        await database.pool.query(
          "SELECT count(*)::int AS n FROM exomem_whats_new_digest_months WHERE month = $1",
          [month]
        )
      ).rows[0].n;
    publish("2038-12", threeNotes());

    process.env.EXOMEM_WHATS_NEW_FIRST_MONTH = "2040-06";
    const early = await build("2038-12");
    assert.deepEqual([early.state, early.firstMonth], [null, "2040-06"]);
    assert.equal(await built("2038-12"), 0);
    assert.equal((await overview()).firstMonth, "2040-06");

    // Unset builds nothing either, and the page shows it unset rather than a month.
    delete process.env.EXOMEM_WHATS_NEW_FIRST_MONTH;
    assert.deepEqual([(await build("2038-12")).state, (await overview()).firstMonth], [null, null]);
    assert.equal(await built("2038-12"), 0);

    // From the first month on the route builds as before.
    process.env.EXOMEM_WHATS_NEW_FIRST_MONTH = "2038-12";
    model.answers.push({ picks: [] });
    assert.notEqual((await build("2038-12")).state, null);
    assert.equal(await built("2038-12"), 1);
    // Leave nothing open, so the later months of this suite lapse nothing.
    await act({ action: "skip", month: "2038-12" });
    process.env.EXOMEM_WHATS_NEW_FIRST_MONTH = "2000-01";
  });

  it("skips a quiet month, where the model returned none and the operator picked none, and does not count it", async () => {
    publish("2040-01", threeNotes());
    publish("2040-01", threeNotes());
    model.answers.push({ picks: [] });
    assert.equal((await build("2040-01")).state, "awaiting_approval");

    const picked = await act({ action: "blind_pick", month: "2040-01", selection: [] });
    assert.deepEqual([picked.body.month.state, picked.body.month.skipReason], ["skipped", "quiet"]);
    assert.deepEqual((await overview()).measurement.run, []);
  });

  it("counts a month the model left empty and the operator filled, scoring it 0", async () => {
    const version = publish("2040-02", [...threeNotes(), note(null, "Fourth change.")]);
    model.answers.push({ picks: [] });
    await build("2040-02");
    await act({ action: "blind_pick", month: "2040-02", selection: three(version) });

    // The model's "none" has nothing to approve; the operator's own three go out as an edit.
    const refused = await act({ action: "approve", month: "2040-02" });
    assert.equal(refused.body.error.code, "WHATS_NEW_DIGEST_SELECTION_INVALID");
    const edited = await act({
      action: "edit",
      month: "2040-02",
      selection: [id(version, 2), id(version, 0), id(version, 1)],
    });
    assert.deepEqual(
      [edited.body.month.state, edited.body.month.decision],
      ["ready_to_queue", "edited"]
    );
    assert.deepEqual(
      edited.body.month.finalSelection?.map((n) => n.position),
      [2, 0, 1]
    );

    const run = (await overview()).measurement.run;
    assert.deepEqual(
      run.map((s) => [s.month, s.both, s.operatorPicks, s.passes]),
      [["2040-02", 0, 3, false]]
    );
  });

  it("refuses an edit outside three to six notes of the month and approves nothing", async () => {
    const version = publish("2040-03", [...threeNotes(), note(null, "Fourth change.")]);
    model.answers.push({ picks: three(version) });
    await build("2040-03");
    await act({ action: "blind_pick", month: "2040-03", selection: three(version) });
    for (const selection of [
      [id(version, 0), id(version, 1)],
      [...three(version), id(version, 3), id(version, 3)],
      [...three(version).slice(0, 2), id("99.0.0", 0)],
    ]) {
      const refused = await act({ action: "edit", month: "2040-03", selection });
      assert.equal(refused.status, 400);
    }
    assert.equal((await detail("2040-03")).state, "awaiting_approval");
    assert.equal(
      (await act({ action: "skip", month: "2040-03" })).body.month.skipReason,
      "operator"
    );
  });

  it("skips a month with fewer notes than the bar without calling the model", async () => {
    publish("2040-04", [note(null, "Only change.")]);
    publish("2040-04", []);
    const calls = model.requests.length;
    const run = await build("2040-04");
    assert.equal(run.state, "skipped");
    assert.equal((await detail("2040-04")).skipReason, "too_few_notes");
    assert.equal(model.requests.length, calls);
  });

  it("keeps a month waiting for a missing or unreadable release until the operator accepts it without", async () => {
    const good = publish("2040-05", [...threeNotes(), note(null, "Fourth change.")]);
    const absent = publish("2040-05", null);
    const garbled = publish("2040-05", "unreadable");
    const run = await build("2040-05");
    assert.deepEqual([run.state, run.missingReleases], ["waiting_for_notes", 2]);
    const month = await detail("2040-05");
    assert.deepEqual(
      month.releases.missing.map((r) => [r.version, r.problem]).sort(),
      [
        [absent, "no_asset"],
        [garbled, "unreadable"],
      ].sort()
    );

    // Nothing can be picked or approved while the month waits.
    assert.equal(
      (await act({ action: "blind_pick", month: "2040-05", selection: three(good) })).status,
      409
    );
    assert.equal((await act({ action: "approve", month: "2040-05" })).status, 409);
    // A release that has its notes is not one to accept without.
    assert.equal(
      (await act({ action: "accept_missing", month: "2040-05", versions: [good] })).status,
      409
    );

    assert.equal(
      (await act({ action: "accept_missing", month: "2040-05", versions: [absent] })).body.month
        .state,
      "waiting_for_notes"
    );
    const accepted = await act({ action: "accept_missing", month: "2040-05", versions: [garbled] });
    assert.deepEqual(
      [accepted.body.month.state, accepted.body.month.releases.acceptedWithout],
      ["waiting_for_model", 2]
    );

    // The month is built from the releases that have notes.
    model.answers.push({ picks: three(good) });
    assert.equal((await build("2040-05")).state, "awaiting_approval");
    assert.equal((await detail("2040-05")).notes.length, 4);
    await act({ action: "skip", month: "2040-05" });
  });

  it("lapses a month that still waits when the next month is built, and it can never be approved", async () => {
    const version = publish("2040-06", threeNotes());
    model.answers.push({ picks: three(version) });
    await build("2040-06");
    await act({ action: "blind_pick", month: "2040-06", selection: three(version) });

    publish("2040-07", threeNotes());
    const run = await build("2040-07");
    assert.deepEqual([run.month, run.lapsedMonths], ["2040-07", 1]);
    const lapsed = await detail("2040-06");
    assert.equal(lapsed.state, "lapsed");
    assert.equal((await act({ action: "approve", month: "2040-06" })).status, 409);
    assert.equal(
      (await act({ action: "edit", month: "2040-06", selection: three(version) })).status,
      409
    );
    assert.equal((await detail("2040-06")).finalSelection, null);
    await act({ action: "skip", month: "2040-07" });
  });

  it("skips a month at once on a blind pick of none, then still records the model's ranking for the measurement", async () => {
    // The month's calendar place is out of order on purpose: nothing earlier is open, so nothing lapses.
    const version = publish("2039-12", threeNotes());
    model.answers.push({ status: 500 }, { status: 500 });
    assert.equal((await build("2039-12")).state, "waiting_for_model");
    const picked = await act({ action: "blind_pick", month: "2039-12", selection: [] });
    assert.deepEqual(
      [picked.body.month.state, picked.body.month.skipReason],
      ["skipped", "operator"]
    );
    assert.equal(picked.body.month.rankingPending, true);
    // No ranking yet, so nothing to count yet.
    assert.equal(
      (await overview()).measurement.run.some((entry) => entry.month === "2039-12"),
      false
    );

    // The next run asks the model once more; the answer is recorded and the month stays skipped.
    model.requests.length = 0;
    model.answers.push({ picks: three(version) });
    assert.equal((await build("2039-12")).state, "skipped");
    assert.equal(model.requests.length, 1);
    const month = await detail("2039-12");
    assert.deepEqual(
      [month.state, month.skipReason, month.rankingPending],
      ["skipped", "operator", false]
    );
    assert.equal(month.model?.selection.length, 3);
    // The model would have sent and the operator did not: a disagreement, scored 0, that counts.
    const share = (await overview()).measurement.run.find((entry) => entry.month === "2039-12");
    assert.deepEqual(
      [share?.both, share?.operatorPicks, share?.modelPicks, share?.passes],
      [0, 0, 3, false]
    );
    // A skipped month is ranked once.
    model.requests.length = 0;
    await build("2039-12");
    assert.equal(model.requests.length, 0);
  });

  it("reads a month skipped on a blind none as quiet when the model's ranking, arriving later, is none too", async () => {
    publish("2039-11", threeNotes());
    model.answers.push({ status: 500 }, { status: 500 });
    await build("2039-11");
    await act({ action: "blind_pick", month: "2039-11", selection: [] });
    model.answers.push({ picks: [] });
    await build("2039-11");
    assert.deepEqual(
      [(await detail("2039-11")).state, (await detail("2039-11")).skipReason],
      ["skipped", "quiet"]
    );
    // Both sides picked none: quiet, and it does not count.
    assert.equal(
      (await overview()).measurement.run.some((entry) => entry.month === "2039-11"),
      false
    );
  });

  it("stops a month that is ready to queue, and refuses to stop one that is not", async () => {
    const version = publish("2039-10", threeNotes());
    model.answers.push({ picks: three(version) });
    await build("2039-10");
    // Not yet approved: nothing to stop (the operator skips instead).
    assert.equal((await act({ action: "stop", month: "2039-10" })).status, 409);
    await act({ action: "blind_pick", month: "2039-10", selection: three(version) });
    assert.equal((await act({ action: "approve", month: "2039-10" })).body.month.canStop, true);

    const stopped = await act({ action: "stop", month: "2039-10" });
    assert.deepEqual(
      [stopped.body.month.state, stopped.body.month.skipReason, stopped.body.month.canStop],
      ["skipped", "operator", false]
    );
    // What was approved stays on record, and the month counts: its blind pick and ranking are in.
    assert.equal(stopped.body.month.finalSelection?.length, 3);
    assert.equal((await act({ action: "stop", month: "2039-10" })).status, 409);
    assert.equal((await act({ action: "approve", month: "2039-10" })).status, 409);
  });

  it("stops early on a spent time budget, leaves the month waiting, and resumes from the record on the next run", async () => {
    const version = publish("2039-09", threeNotes());
    const before = github.requests.length;
    // No time at all: nothing is requested, and the month is only recorded.
    const none = await runWhatsNewDigestSelection({
      now: nextMonth("2039-09"),
      deadlineAt: Date.now() - 1,
    });
    assert.deepEqual([none.state, github.requests.length], ["waiting_for_notes", before]);

    // Time for GitHub but not for a model attempt: the notes are kept, no model call is made,
    // and the month is not marked as a model outage.
    model.requests.length = 0;
    const partial = await runWhatsNewDigestSelection({
      now: nextMonth("2039-09"),
      deadlineAt: Date.now() + 5_000,
    });
    assert.equal(partial.state, "waiting_for_model");
    assert.equal(model.requests.length, 0);
    assert.equal((await detail("2039-09")).modelStatus, null);

    model.answers.push({ picks: three(version) });
    assert.equal((await build("2039-09")).state, "awaiting_approval");
    await act({ action: "skip", month: "2039-09" });
  });

  describe("sending without approval", () => {
    const measuredMonths = ["2040-08", "2040-09", "2040-10"];

    // The earlier months of this suite ran under the default model, and one of them scored 0; a
    // model of its own starts this measurement at its first month.
    before(() => {
      process.env.EXOMEM_WHATS_NEW_MODEL = "model-a";
    });

    it("offers the switch only after three approved months that each reach two thirds", async () => {
      for (const month of measuredMonths) {
        const version = publish(month, [...threeNotes(), note(null, "Fourth change.")]);
        model.answers.push({ picks: three(version) });
        await build(month);
        assert.equal(
          (await act({ action: "set_switch", on: true })).status,
          409,
          `before ${month}`
        );
        await act({ action: "blind_pick", month, selection: three(version) });
        assert.equal((await act({ action: "approve", month })).status, 200);
      }
      const state = await overview();
      assert.deepEqual(
        [state.measurement.complete, state.measurement.allPass, state.measurement.offered],
        [true, true, true]
      );

      const on = await act({ action: "set_switch", on: true });
      assert.equal(on.body.overview.switch.sendWithoutApproval, true);
      const { rows } = await database.pool.query(
        "SELECT model_id, model_reported, prompt_version, shares FROM exomem_whats_new_digest_switch"
      );
      assert.deepEqual(
        [rows[0].model_id, rows[0].model_reported, rows[0].prompt_version, rows[0].shares.length],
        ["model-a", "model-a", WHATS_NEW_PROMPT_VERSION, 3]
      );
    });

    it("sends the next month's selection on without approval, and skips a quiet one", async () => {
      const version = publish("2040-11", threeNotes());
      model.answers.push({ picks: three(version) });
      await build("2040-11");
      const month = await detail("2040-11");
      assert.deepEqual([month.state, month.decision], ["ready_to_queue", "automatic"]);
      assert.equal(month.blindPick, null);
      // A day's window in which the operator can stop it: the fan-out starts only after it.
      const waitMs = new Date(month.sendAfter!).getTime() - Date.now();
      assert.ok(waitMs > 23 * 3_600_000 && waitMs <= 24 * 3_600_000, `send_after in ${waitMs} ms`);
      assert.equal(month.canStop, true);

      publish("2040-12", threeNotes());
      model.answers.push({ picks: [] });
      await build("2040-12");
      assert.deepEqual(
        [(await detail("2040-12")).state, (await detail("2040-12")).skipReason],
        ["skipped", "quiet"]
      );
    });

    it("asks for approval again when the model changes, and measures the new model from the start", async () => {
      process.env.EXOMEM_WHATS_NEW_MODEL = "model-b";
      const version = publish("2041-01", threeNotes());
      model.answers.push({ picks: three(version) });
      await build("2041-01");
      assert.equal((await detail("2041-01")).state, "awaiting_approval");
      const state = await overview();
      assert.equal(state.switch.applies, false);
      assert.equal(state.measurement.offered, false);

      const off = await act({ action: "set_switch", on: false });
      assert.equal(off.body.overview.switch.sendWithoutApproval, false);
    });

    it("asks for approval again when the API reports a different model under the same configured name", async () => {
      process.env.EXOMEM_WHATS_NEW_MODEL = "model-a";
      // Turn the switch on again: it records the identity measured, model-a as the API reported it.
      assert.equal((await act({ action: "set_switch", on: true })).status, 200);
      const version = publish("2041-02", threeNotes());
      model.answers.push({ picks: three(version), model: "model-a-20261201" });
      await build("2041-02");
      assert.equal((await detail("2041-02")).state, "awaiting_approval");
      assert.equal((await overview()).switch.applies, false);
      await act({ action: "set_switch", on: false });
    });
  });
});
