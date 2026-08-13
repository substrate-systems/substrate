import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  holdD1ExpandPreflight,
  verifyExpandDeploymentLockPair,
} from "../../../../scripts/exomem-d1-expand-preflight";

function releaseSetDigest(
  pairs: Array<{ releaseVersion: string; protocolVersion: string }>
): string {
  return createHash("sha256")
    .update(
      `${JSON.stringify(
        pairs.map(({ releaseVersion, protocolVersion }) => ({ protocolVersion, releaseVersion }))
      )}\n`
    )
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .map(([key, child]) => [key, sort(child)])
          )
        : entry;
  return `${JSON.stringify(sort(value))}\n`;
}

function lockPairBytes(): Buffer {
  const pairs = [
    { releaseVersion: "0.39.2", protocolVersion: "1" },
    { releaseVersion: "0.49.0", protocolVersion: "1" },
  ];
  const member = (admissionMode: "expand" | "contract") => ({
    artifact: "exomem-hosted-deployment-lock",
    schemaVersion: 2,
    admissionMode,
    runtimeTarget: {
      releaseVersion: "0.49.0",
      protocolVersion: "1",
      agentProfile: "hosted-alpha-agent-v1",
    },
    composition: {
      legacyCatalog: pairs,
      legacyReleaseSetSha256: releaseSetDigest(pairs),
    },
  });
  return Buffer.from(
    canonicalJson({
      artifact: "exomem-hosted-deployment-lock-pair",
      schemaVersion: 2,
      locks: [member("expand"), member("contract")],
    })
  );
}

describe("Hosted Exomem D1 expand preflight", () => {
  it("provides one reviewed parser and one cohort-locking preflight entrypoint", async () => {
    assert.equal(typeof verifyExpandDeploymentLockPair, "function");
    assert.equal(typeof holdD1ExpandPreflight, "function");
  });

  it("binds canonical expand and contract members to the reviewed pair hash and release set", () => {
    const bytes = lockPairBytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.deepEqual(verifyExpandDeploymentLockPair(bytes, sha256), {
      lockPairSha256: sha256,
      releaseSetSha256: releaseSetDigest([
        { releaseVersion: "0.39.2", protocolVersion: "1" },
        { releaseVersion: "0.49.0", protocolVersion: "1" },
      ]),
      releasePairs: [
        { releaseVersion: "0.39.2", protocolVersion: "1" },
        { releaseVersion: "0.49.0", protocolVersion: "1" },
      ],
      forwardPair: { releaseVersion: "0.49.0", protocolVersion: "1" },
    });
    assert.throws(
      () => verifyExpandDeploymentLockPair(bytes, "0".repeat(64)),
      /deployment-lock pair SHA-256 mismatch/i
    );
  });

  it("rejects noncanonical, divergent, duplicated, or mis-digested lock members", () => {
    const canonicalBytes = lockPairBytes();
    const body = JSON.parse(canonicalBytes.toString("utf8")) as Record<string, unknown>;
    const mutations = [
      Buffer.from(JSON.stringify(body)),
      Buffer.from(
        canonicalJson({
          ...body,
          locks: [
            ...(body.locks as Array<Record<string, unknown>>).slice(0, 1),
            {
              ...(body.locks as Array<Record<string, unknown>>)[1],
              runtimeTarget: {
                ...((body.locks as Array<Record<string, unknown>>)[1]!.runtimeTarget as object),
                releaseVersion: "0.50.0",
              },
            },
          ],
        })
      ),
      Buffer.from(
        canonicalJson({
          ...body,
          locks: (body.locks as Array<Record<string, unknown>>).map((lock) => ({
            ...lock,
            composition: {
              ...(lock.composition as object),
              legacyCatalog: [
                ...(lock.composition as { legacyCatalog: unknown[] }).legacyCatalog,
                (lock.composition as { legacyCatalog: unknown[] }).legacyCatalog[0],
              ],
            },
          })),
        })
      ),
      Buffer.from(
        canonicalJson({
          ...body,
          locks: (body.locks as Array<Record<string, unknown>>).map((lock) => ({
            ...lock,
            composition: {
              ...(lock.composition as object),
              legacyReleaseSetSha256: "f".repeat(64),
            },
          })),
        })
      ),
    ];
    for (const bytes of mutations) {
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.throws(() => verifyExpandDeploymentLockPair(bytes, sha256));
    }
  });

  it("holds the cohort lock after exact under-lock release-set proof until explicitly released", async () => {
    const bytes = lockPairBytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const statements: string[] = [];
    const statuses: Array<Record<string, unknown>> = [];
    let release!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = {
      query: async (text: string) => {
        statements.push(text);
        if (text.includes("exomem:d1-current-release-set")) {
          return {
            rows: [
              { release_version: "0.39.2", protocol_version: "1" },
              { release_version: "0.49.0", protocol_version: "1" },
            ],
          };
        }
        return { rows: [] };
      },
    };
    const held = holdD1ExpandPreflight({
      client,
      deploymentLockPairBytes: bytes,
      expectedLockPairSha256: sha256,
      waitForRelease: () => releaseSignal,
      onStatus: (status) => statuses.push(status),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      statements.some((statement) => statement.includes("pg_advisory_lock")),
      true
    );
    assert.equal(
      statements.some((statement) => statement.includes("COMMIT")),
      true
    );
    const releaseSetQuery = statements.find((statement) =>
      statement.includes("exomem:d1-current-release-set")
    );
    assert.ok(releaseSetQuery);
    assert.match(releaseSetQuery, /exomem_routable_cell_contracts/i);
    assert.match(releaseSetQuery, /exomem_agent_contract_candidates/i);
    assert.match(releaseSetQuery, /exomem_agent_contract_rollout_assignments/i);
    assert.match(releaseSetQuery, /provisioner_wire_protocol = 'exomem-cell-provisioner\.v1'/i);
    assert.match(releaseSetQuery, /state NOT IN \('succeeded', 'failed_terminal'\)/i);
    assert.match(releaseSetQuery, /exomem_exports/i);
    assert.match(releaseSetQuery, /export_row\.state <> 'deleted'/i);
    assert.match(releaseSetQuery, /COLLATE "C"/i);
    assert.deepEqual(statuses, [
      {
        status: "held",
        lockPairSha256: sha256,
        releaseSetSha256: releaseSetDigest([
          { releaseVersion: "0.39.2", protocolVersion: "1" },
          { releaseVersion: "0.49.0", protocolVersion: "1" },
        ]),
        releasePairCount: 2,
      },
    ]);
    release();
    assert.deepEqual(await held, {
      status: "released",
      lockPairSha256: sha256,
      releaseSetSha256: releaseSetDigest([
        { releaseVersion: "0.39.2", protocolVersion: "1" },
        { releaseVersion: "0.49.0", protocolVersion: "1" },
      ]),
      releasePairCount: 2,
    });
    assert.equal(statements.at(-1)?.includes("pg_advisory_unlock"), true);
  });

  it("aborts and unlocks when the under-lock release set differs", async () => {
    const bytes = lockPairBytes();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const statements: string[] = [];
    const client = {
      query: async (text: string) => {
        statements.push(text);
        if (text.includes("exomem:d1-current-release-set")) {
          return { rows: [{ release_version: "0.49.0", protocol_version: "1" }] };
        }
        return { rows: [] };
      },
    };
    await assert.rejects(
      holdD1ExpandPreflight({
        client,
        deploymentLockPairBytes: bytes,
        expectedLockPairSha256: sha256,
        waitForRelease: async () => undefined,
      }),
      /current release-set digest does not match/i
    );
    assert.equal(
      statements.some((statement) => statement.includes("ROLLBACK")),
      true
    );
    assert.equal(statements.at(-1)?.includes("pg_advisory_unlock"), true);
  });
});
