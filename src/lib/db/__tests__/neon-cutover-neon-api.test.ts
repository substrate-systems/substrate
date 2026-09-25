import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  neonHttpTransport,
  readRotatedPasswords,
  recordRotatedPassword,
  rotateNeonRolePassword,
  runCutover,
  type CutoverEnv,
  type NeonTransport,
} from "../../../../scripts/neon-cutover";

// The cutover's second rotation path (task 4.1 rulings): a console-managed
// Neon role, including the owner role Vercel's DATABASE_URL uses, is rotated
// through Neon's reset-password endpoint, so a compute restart re-applies the
// new password instead of undoing a SQL-only rotation. Every call here goes
// through an injected transport; nothing contacts Neon.

const KEY = "neon-api-key-that-must-never-print";
const ROTATED = "RotatedPw4TheOwnerRole0123456789";
const RESET_PATH =
  "/projects/quiet-sky-123456/branches/br-main-0001/roles/neondb_owner/reset_password";
const workDir = mkdtempSync(join(tmpdir(), "neon-cutover-api-"));

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function recordingTransport(
  answer: (
    path: string,
    init: RequestInit | undefined,
    call: number
  ) => Response | Promise<Response>
): { transport: NeonTransport; calls: Array<{ path: string; method: string }> } {
  const calls: Array<{ path: string; method: string }> = [];
  return {
    calls,
    transport: async (path, init) => {
      calls.push({ path, method: init?.method ?? "GET" });
      return answer(path, init, calls.length);
    },
  };
}

const rotate = (transport: NeonTransport) =>
  rotateNeonRolePassword({
    transport,
    projectId: "quiet-sky-123456",
    branchId: "br-main-0001",
    role: "neondb_owner",
    pollIntervalMs: 0,
  });

async function run(
  args: string[],
  env: CutoverEnv = {},
  stdout: { isTTY: boolean; written: string[] } = { isTTY: false, written: [] },
  neonTransport?: NeonTransport
): Promise<{ code: number; output: string; stdout: string }> {
  const lines: string[] = [];
  const code = await runCutover(
    args,
    env,
    {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
      stdout: { isTTY: stdout.isTTY, write: (text) => stdout.written.push(text) },
    },
    { neonTransport }
  );
  return { code, output: lines.join("\n"), stdout: stdout.written.join("") };
}

after(() => rmSync(workDir, { recursive: true, force: true }));

describe("Neon API rotation", () => {
  it("the HTTP transport calls Neon's v2 API with the bearer key", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const transport = neonHttpTransport(KEY, async (url, init) => {
      seen.push({ url: String(url), init });
      return json(200, {});
    });
    await transport(RESET_PATH, { method: "POST" });
    assert.equal(seen[0]!.url, `https://console.neon.tech/api/v2${RESET_PATH}`);
    assert.equal(seen[0]!.init?.method, "POST");
    const headers = new Headers(seen[0]!.init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(headers.get("accept"), "application/json");
  });

  it("returns the new password once every operation has finished", async () => {
    const { transport, calls } = recordingTransport((path, _init, call) => {
      if (call === 1) {
        return json(200, {
          role: {
            branch_id: "br-main-0001",
            name: "neondb_owner",
            password: ROTATED,
            protected: false,
          },
          operations: [
            { id: "op-apply", action: "apply_config", status: "running" },
            { id: "op-done", action: "apply_config", status: "finished" },
          ],
        });
      }
      return json(200, {
        operation: { id: "op-apply", status: call === 2 ? "running" : "finished" },
      });
    });
    assert.equal(await rotate(transport), ROTATED);
    assert.deepEqual(calls, [
      { path: RESET_PATH, method: "POST" },
      { path: "/projects/quiet-sky-123456/operations/op-apply", method: "GET" },
      { path: "/projects/quiet-sky-123456/operations/op-apply", method: "GET" },
    ]);
  });

  it("fails on a 4xx, naming the status and Neon's error code but never the key", async () => {
    const { transport } = recordingTransport(() =>
      json(403, { request_id: "req-1", code: "PERMISSION_DENIED", message: "not allowed" })
    );
    await assert.rejects(rotate(transport), (error: Error) => {
      assert.match(error.message, /403/);
      assert.match(error.message, /PERMISSION_DENIED/);
      assert.doesNotMatch(error.message, new RegExp(KEY));
      return true;
    });
  });

  it("fails on a network failure without retrying the reset", async () => {
    const { transport, calls } = recordingTransport(() => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(rotate(transport), /could not reach the Neon API/);
    assert.equal(calls.length, 1);
  });

  it("fails when the response does not contain the new password", async () => {
    const { transport } = recordingTransport(() =>
      json(200, { role: { name: "neondb_owner" }, operations: [] })
    );
    await assert.rejects(rotate(transport), /did not return the new password/);
  });

  it("fails when the response names another role", async () => {
    const { transport } = recordingTransport(() =>
      json(200, { role: { name: "someone_else", password: ROTATED }, operations: [] })
    );
    await assert.rejects(rotate(transport), /did not return the new password/);
  });

  it("fails when an operation that applies the password fails", async () => {
    const { transport } = recordingTransport((_path, _init, call) =>
      call === 1
        ? json(200, {
            role: { branch_id: "br-main-0001", name: "neondb_owner", password: ROTATED },
            operations: [{ id: "op-apply", status: "running" }],
          })
        : json(200, { operation: { id: "op-apply", status: "failed" } })
    );
    await assert.rejects(rotate(transport), /op-apply.*failed/);
  });

  // Neon's operations guide: "the unsuccessful terminal statuses are failed,
  // error, and cancelled" (https://neon.com/docs/manage/operations).
  it("treats an operation in error status as finished unsuccessfully, as Neon documents", async () => {
    const { transport, calls } = recordingTransport((_path, _init, call) =>
      call === 1
        ? json(200, {
            role: { branch_id: "br-main-0001", name: "neondb_owner", password: ROTATED },
            operations: [{ id: "op-apply", status: "running" }],
          })
        : json(200, { operation: { id: "op-apply", status: "error" } })
    );
    await assert.rejects(rotate(transport), /op-apply.*error/);
    assert.equal(calls.length, 2);
  });

  it("records the password, then fails, when Neon reset the role on another branch", async () => {
    const recorded: string[] = [];
    const { transport } = recordingTransport(() =>
      json(200, {
        role: { branch_id: "br-other-0002", name: "neondb_owner", password: ROTATED },
        operations: [],
      })
    );
    await assert.rejects(
      rotateNeonRolePassword({
        transport,
        projectId: "quiet-sky-123456",
        branchId: "br-main-0001",
        role: "neondb_owner",
        record: (password) => recorded.push(password),
        pollIntervalMs: 0,
      }),
      /br-other-0002.*br-main-0001/
    );
    assert.deepEqual(recorded, [ROTATED], "a password Neon issued is never lost");
  });
});

describe("rotated password file", () => {
  it("is created 0600 and only appended to; the newest entry for a role wins", () => {
    const file = join(workDir, "rotated.jsonl");
    recordRotatedPassword(file, "neondb_owner", "FirstRotatedPassword000000000000");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    recordRotatedPassword(file, "other_role", "AnotherRotatedPassword000000000");
    recordRotatedPassword(file, "neondb_owner", ROTATED);
    assert.deepEqual(
      [...readRotatedPasswords(file)].sort(),
      [
        ["neondb_owner", ROTATED],
        ["other_role", "AnotherRotatedPassword000000000"],
      ]
    );
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3, "nothing is replaced");
  });

  it("starts a new line when the last entry has no newline", () => {
    const file = join(workDir, "no-newline.jsonl");
    writeFileSync(file, JSON.stringify({ role: "a_role", password: "PasswordA0123456789" }), {
      mode: 0o600,
    });
    recordRotatedPassword(file, "b_role", "PasswordB0123456789");
    assert.deepEqual(
      [...readRotatedPasswords(file)].sort(),
      [
        ["a_role", "PasswordA0123456789"],
        ["b_role", "PasswordB0123456789"],
      ]
    );
  });

  it("refuses a symbolic link, a dangling one and a missing directory, and writes nothing", () => {
    const target = join(workDir, "link-target.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    const linked = join(workDir, "linked.jsonl");
    symlinkSync(target, linked);
    assert.throws(() => recordRotatedPassword(linked, "a_role", ROTATED), /symbolic link/);
    assert.equal(readFileSync(target, "utf8"), "");
    const dangling = join(workDir, "dangling.jsonl");
    symlinkSync(join(workDir, "nowhere.jsonl"), dangling);
    assert.throws(() => recordRotatedPassword(dangling, "a_role", ROTATED), /symbolic link/);
    assert.equal(existsSync(join(workDir, "nowhere.jsonl")), false);
    assert.throws(
      () => recordRotatedPassword(join(workDir, "absent-dir", "rotated.jsonl"), "a_role", ROTATED),
      /directory .* does not exist/
    );
  });

  it("refuses to append to a file others can read", () => {
    const file = join(workDir, "loose-append.jsonl");
    writeFileSync(file, "", { mode: 0o600 });
    chmodSync(file, 0o640);
    assert.throws(() => recordRotatedPassword(file, "a_role", ROTATED), /mode 640.*0600/);
    assert.equal(readFileSync(file, "utf8"), "");
  });

  it("is refused when anyone but its owner can read it", () => {
    const file = join(workDir, "loose.jsonl");
    writeFileSync(file, `${JSON.stringify({ role: "neondb_owner", password: ROTATED })}\n`);
    chmodSync(file, 0o644);
    assert.throws(() => readRotatedPasswords(file), /readable by others/);
  });

  it("reads as empty when it does not exist yet", () => {
    assert.equal(readRotatedPasswords(join(workDir, "absent.jsonl")).size, 0);
  });
});

describe("freeze's checks before any Neon reset", () => {
  // A local admin URL on a port nothing listens on: a check that ran too late
  // would show as ECONNREFUSED instead of its own refusal.
  const local = "postgresql://neondb_owner:OriginalPw@127.0.0.1:1/neondb?sslmode=disable";
  const apiEnv = {
    CUTOVER_SOURCE_ADMIN_URL: local,
    CUTOVER_ROLE_URL_NEONDB_OWNER: local,
    NEON_API_KEY: KEY,
    NEON_PROJECT_ID: "quiet-sky-123456",
    NEON_BRANCH_ID: "br-main-0001",
    NEON_ENDPOINT_ID: "ep-quiet-sky-123456",
  };
  const freezeWith = (file: string, env: CutoverEnv, transport: NeonTransport) =>
    run(
      [
        "freeze",
        "--app-roles=neondb_owner",
        "--api-roles=neondb_owner",
        `--rotated-password-file=${file}`,
        "--confirm-production",
      ],
      env,
      undefined,
      transport
    );

  for (const [label, prepare, reason] of [
    ["a missing directory", () => join(workDir, "no-such-dir", "rotated.jsonl"), /does not exist/],
    [
      "a symbolic link",
      () => {
        const target = join(workDir, "freeze-link-target.jsonl");
        writeFileSync(target, "", { mode: 0o600 });
        symlinkSync(target, join(workDir, "freeze-link.jsonl"));
        return join(workDir, "freeze-link.jsonl");
      },
      /symbolic link/,
    ],
    [
      "a dangling symbolic link",
      () => {
        symlinkSync(join(workDir, "freeze-nowhere.jsonl"), join(workDir, "freeze-dangling.jsonl"));
        return join(workDir, "freeze-dangling.jsonl");
      },
      /symbolic link/,
    ],
    [
      "a file others can read",
      () => {
        const file = join(workDir, "freeze-loose.jsonl");
        writeFileSync(file, "", { mode: 0o600 });
        chmodSync(file, 0o644);
        return file;
      },
      /mode 644/,
    ],
  ] as const) {
    it(`refuses ${label} as the rotated-password file before any Neon call`, async () => {
      const { transport, calls } = recordingTransport(() => json(500, {}));
      const { code, output } = await freezeWith(prepare(), apiEnv, transport);
      assert.equal(code, 1, output);
      assert.match(output, reason);
      assert.deepEqual(calls, [], "no Neon call may precede a file that cannot record the password");
    });
  }

  const endpointAnswer =
    (branchId: string) =>
    (path: string): Response =>
      path === "/projects/quiet-sky-123456/endpoints/ep-quiet-sky-123456"
        ? json(200, {
            endpoint: {
              id: "ep-quiet-sky-123456",
              project_id: "quiet-sky-123456",
              branch_id: branchId,
              host: "ep-quiet-sky-123456.eu-central-1.aws.neon.tech",
            },
          })
        : json(500, { code: "UNEXPECTED" });
  // .invalid never resolves, so nothing here can reach a real server.
  const neonHost = "ep-quiet-sky-123456.eu-central-1.aws.neon.invalid";
  const remote = `postgresql://neondb_owner:OriginalPw@${neonHost}/neondb?sslmode=require`;
  const remoteEnv = {
    ...apiEnv,
    CUTOVER_SOURCE_ADMIN_URL: remote,
    CUTOVER_ROLE_URL_NEONDB_OWNER: remote,
    NEON_ENDPOINT_ID: undefined,
  };

  it("refuses when the admin URL's endpoint belongs to another branch than NEON_BRANCH_ID", async () => {
    const { transport, calls } = recordingTransport(endpointAnswer("br-p5-rehearsal-0009"));
    const { code, output } = await freezeWith(
      join(workDir, "branch-mismatch.jsonl"),
      remoteEnv,
      transport
    );
    assert.equal(code, 1, output);
    assert.match(output, /br-p5-rehearsal-0009/);
    assert.match(output, /br-main-0001/);
    assert.deepEqual(calls, [
      { path: "/projects/quiet-sky-123456/endpoints/ep-quiet-sky-123456", method: "GET" },
    ]);
  });

  it("looks the endpoint up before connecting, and carries on when its branch matches", async () => {
    const { transport, calls } = recordingTransport(endpointAnswer("br-main-0001"));
    const { code, output } = await freezeWith(
      join(workDir, "branch-match.jsonl"),
      remoteEnv,
      transport
    );
    // It gets as far as connecting, to a host that does not resolve.
    assert.equal(code, 1, output);
    assert.match(output, /ENOTFOUND/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "GET");
  });

  it("refuses an admin host that names no Neon endpoint", async () => {
    const { transport, calls } = recordingTransport(endpointAnswer("br-main-0001"));
    const other = "postgresql://neondb_owner:OriginalPw@db.example.invalid/neondb";
    const { code, output } = await freezeWith(
      join(workDir, "no-endpoint.jsonl"),
      { ...remoteEnv, CUTOVER_SOURCE_ADMIN_URL: other, CUTOVER_ROLE_URL_NEONDB_OWNER: other },
      transport
    );
    assert.equal(code, 1, output);
    assert.match(output, /endpoint/);
    assert.deepEqual(calls, []);
  });
});

describe("API-path guards and the switch-back", () => {
  const neonUrl = `postgresql://neondb_owner:OriginalPw@ep-quiet-sky-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require`;

  it("freeze on the API path needs the Neon API variables and a password file before connecting", async () => {
    const { code, output } = await run(
      ["freeze", "--app-roles=neondb_owner", "--api-roles=neondb_owner", "--confirm-production"],
      {
        CUTOVER_SOURCE_ADMIN_URL: neonUrl,
        CUTOVER_ROLE_URL_NEONDB_OWNER: neonUrl,
        NEON_API_KEY: KEY,
      }
    );
    assert.equal(code, 1, output);
    assert.match(output, /NEON_PROJECT_ID/);
    assert.match(output, /NEON_BRANCH_ID/);
    assert.match(output, /--rotated-password-file/);
    assert.doesNotMatch(output, new RegExp(KEY));
  });

  it("an empty --api-roles puts every role on the SQL path, needing no Neon API variables", async () => {
    const local = "postgresql://app:pw@127.0.0.1:1/neondb?sslmode=disable";
    const { code, output } = await run(["freeze", "--app-roles=app", "--api-roles="], {
      CUTOVER_SOURCE_ADMIN_URL: local,
      CUTOVER_ROLE_URL_APP: local,
    });
    // It gets as far as connecting, to a port nothing listens on.
    assert.equal(code, 1, output);
    assert.match(output, /ECONNREFUSED/);
    assert.doesNotMatch(output, /NEON_|--api-roles/);
  });

  it("refuses an API role that is not an application role", async () => {
    const { code, output } = await run(
      ["freeze", "--app-roles=app", "--api-roles=neondb_owner", "--confirm-production"],
      {
        CUTOVER_SOURCE_ADMIN_URL: neonUrl,
        CUTOVER_ROLE_URL_APP: neonUrl.replace("neondb_owner", "app"),
      }
    );
    assert.equal(code, 1, output);
    assert.match(output, /--api-roles must be a subset of --app-roles/);
  });

  it("switch-back-url feeds the rotated password on stdin to vercel env add, and never to a terminal", async () => {
    const file = join(workDir, "switch-back.jsonl");
    recordRotatedPassword(file, "neondb_owner", ROTATED);
    const env = { CUTOVER_ROLE_URL_NEONDB_OWNER: neonUrl };
    const args = ["switch-back-url", "--role=neondb_owner", `--rotated-password-file=${file}`];

    const terminal = await run(args, env, { isTTY: true, written: [] });
    assert.equal(terminal.code, 1, terminal.output);
    assert.match(terminal.output, /terminal/);
    assert.equal(terminal.stdout, "");

    const piped = await run(args, env);
    assert.equal(piped.code, 0, piped.output);
    assert.doesNotMatch(piped.output, new RegExp(ROTATED));
    assert.ok(!piped.stdout.endsWith("\n"), "no trailing newline may reach the variable's value");
    const url = new URL(piped.stdout);
    assert.equal(decodeURIComponent(url.username), "neondb_owner");
    assert.equal(decodeURIComponent(url.password), ROTATED);
    assert.equal(url.hostname, "ep-quiet-sky-123456.eu-central-1.aws.neon.tech");
    assert.equal(url.searchParams.get("sslmode"), "require");
    assert.doesNotMatch(readFileSync(file, "utf8"), /OriginalPw/);
  });

  it("switch-back-url refuses a role with no rotated password", async () => {
    const file = join(workDir, "switch-back-missing.jsonl");
    recordRotatedPassword(file, "neondb_owner", ROTATED);
    const { code, output, stdout } = await run(
      ["switch-back-url", "--role=app", `--rotated-password-file=${file}`],
      { CUTOVER_ROLE_URL_APP: neonUrl.replace("neondb_owner", "app") }
    );
    assert.equal(code, 1, output);
    assert.match(output, /no rotated password for app/);
    assert.equal(stdout, "");
  });

  it("switch-plan prints the API-path switch-back pipeline", async () => {
    const { code, output } = await run(["switch-plan"]);
    assert.equal(code, 0, output);
    assert.match(
      output,
      /switch-back-url --role=<role> --rotated-password-file=.* \| vercel env add DATABASE_URL production --sensitive/
    );
  });
});
