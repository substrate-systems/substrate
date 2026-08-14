import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

type JsonObject = Record<string, unknown>;

export type ReleaseProtocolPair = {
  releaseVersion: string;
  protocolVersion: string;
};

export type VerifiedExpandDeploymentLockPair = {
  lockPairSha256: string;
  releaseSetSha256: string;
  releasePairs: ReleaseProtocolPair[];
  forwardPair: ReleaseProtocolPair;
};

type QueryResult = { rows: Array<Record<string, unknown>> };

export type D1ExpandPreflightClient = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult>;
};

export type D1ExpandPreflightStatus = {
  status: "held" | "released";
  lockPairSha256: string;
  catalogReleaseSetSha256: string;
  catalogReleasePairCount: number;
  currentReleaseSetSha256: string;
  currentReleasePairCount: number;
};

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function pairFrom(value: unknown, name: string): ReleaseProtocolPair {
  const row = object(value, name);
  return {
    releaseVersion: string(row.releaseVersion, `${name}.releaseVersion`),
    protocolVersion: string(row.protocolVersion, `${name}.protocolVersion`),
  };
}

function withoutAdmissionMode(lock: JsonObject): JsonObject {
  const rest = { ...lock };
  delete rest.admissionMode;
  return rest;
}

function compareReleasePairs(left: ReleaseProtocolPair, right: ReleaseProtocolPair): number {
  const leftKey = `${left.releaseVersion}\u0000${left.protocolVersion}`;
  const rightKey = `${right.releaseVersion}\u0000${right.protocolVersion}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function verifyExpandDeploymentLockPair(
  bytes: Buffer,
  expectedSha256: string
): VerifiedExpandDeploymentLockPair {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error("deployment-lock pair SHA-256 must be 64 lowercase hexadecimal characters");
  }
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error("deployment-lock pair SHA-256 mismatch");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("deployment-lock pair is not valid JSON");
  }
  if (!bytes.equals(Buffer.from(canonicalJson(parsed)))) {
    throw new Error("deployment-lock pair bytes are not canonical JSON");
  }

  const pair = object(parsed, "deployment-lock pair");
  if (
    pair.artifact !== "exomem-hosted-deployment-lock-pair" ||
    pair.schemaVersion !== 2 ||
    !Array.isArray(pair.locks) ||
    pair.locks.length !== 2
  ) {
    throw new Error("deployment-lock pair shape is invalid");
  }
  const locks = pair.locks.map((value, index) => object(value, `locks[${index}]`));
  const byMode = new Map(locks.map((lock) => [lock.admissionMode, lock]));
  const expand = byMode.get("expand");
  const contract = byMode.get("contract");
  if (!expand || !contract || byMode.size !== 2) {
    throw new Error("deployment-lock pair must contain one expand and one contract member");
  }
  for (const [name, lock] of [
    ["expand", expand],
    ["contract", contract],
  ] as const) {
    if (lock.artifact !== "exomem-hosted-deployment-lock" || lock.schemaVersion !== 2) {
      throw new Error(`${name} deployment lock shape is invalid`);
    }
  }
  if (
    JSON.stringify(withoutAdmissionMode(expand)) !== JSON.stringify(withoutAdmissionMode(contract))
  ) {
    throw new Error("expand and contract deployment locks diverge beyond admissionMode");
  }

  const composition = object(expand.composition, "expand.composition");
  if (!Array.isArray(composition.legacyCatalog) || composition.legacyCatalog.length === 0) {
    throw new Error("expand legacy catalog must be a non-empty array");
  }
  const releasePairs = composition.legacyCatalog.map((entry, index) =>
    pairFrom(entry, `expand.composition.legacyCatalog[${index}]`)
  );
  const sortedPairs = [...releasePairs].sort(compareReleasePairs);
  if (JSON.stringify(releasePairs) !== JSON.stringify(sortedPairs)) {
    throw new Error("expand legacy catalog release pairs are not canonically sorted");
  }
  if (new Set(releasePairs.map((entry) => JSON.stringify(entry))).size !== releasePairs.length) {
    throw new Error("expand legacy catalog contains a duplicate release pair");
  }
  const releaseSetSha256 = sha256(canonicalJson(releasePairs));
  if (composition.legacyReleaseSetSha256 !== releaseSetSha256) {
    throw new Error("expand legacy release-set digest is invalid");
  }

  const forwardPair = pairFrom(expand.runtimeTarget, "expand.runtimeTarget");
  return {
    lockPairSha256: actualSha256,
    releaseSetSha256,
    releasePairs,
    forwardPair,
  };
}

export async function holdD1ExpandPreflight(input: {
  client: D1ExpandPreflightClient;
  deploymentLockPairBytes: Buffer;
  expectedLockPairSha256: string;
  waitForRelease: () => Promise<void>;
  onStatus?: (status: D1ExpandPreflightStatus) => void;
}): Promise<D1ExpandPreflightStatus> {
  const verified = verifyExpandDeploymentLockPair(
    input.deploymentLockPairBytes,
    input.expectedLockPairSha256
  );
  let locked = false;
  let transactionOpen = false;
  try {
    await input.client.query("SELECT pg_advisory_lock(hashtext('exomem-hosted-alpha-cohort'))");
    locked = true;
    await input.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    transactionOpen = true;
    const { rows } = await input.client.query(
      `/* exomem:d1-current-release-set */
       WITH current_release_pairs AS (
         SELECT route.source_release AS release_version,
                route.protocol_version
         FROM exomem_routable_cell_contracts AS route
         WHERE route.profile_id = 'hosted-alpha-agent-v1'
           AND route.routable = true

         UNION ALL

         SELECT candidate.source_release AS release_version,
                candidate.protocol_version
         FROM exomem_agent_contract_candidates AS candidate
         WHERE candidate.profile_id = 'hosted-alpha-agent-v1'
           AND candidate.state = 'live'

         UNION ALL

         SELECT assignment.source_release AS release_version,
                assignment.protocol_version
         FROM exomem_agent_contract_rollout_assignments AS assignment
         JOIN exomem_agent_contract_candidates AS candidate
           ON candidate.id = assignment.candidate_id
          AND candidate.profile_id = 'hosted-alpha-agent-v1'
         WHERE assignment.state IN ('preparing', 'active')

         UNION ALL

         SELECT COALESCE(operation.target_source_release, cell.release_version) AS release_version,
                COALESCE(operation.target_protocol_version, cell.protocol_version) AS protocol_version
         FROM exomem_lifecycle_operations AS operation
         LEFT JOIN exomem_cells AS cell ON cell.id = operation.cell_id
         WHERE operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1'
           AND operation.state NOT IN ('succeeded', 'failed_terminal')

         UNION ALL

         SELECT COALESCE(operation.target_source_release, cell.release_version) AS release_version,
                COALESCE(operation.target_protocol_version, cell.protocol_version) AS protocol_version
         FROM exomem_exports AS export_row
         JOIN exomem_lifecycle_operations AS operation ON operation.id = export_row.operation_id
         LEFT JOIN exomem_cells AS cell
           ON cell.id = COALESCE(operation.cell_id, export_row.cell_id)
         WHERE export_row.state <> 'deleted'
           AND operation.provisioner_wire_protocol = 'exomem-cell-provisioner.v1'

       )
       SELECT release_version, protocol_version
       FROM (
         SELECT DISTINCT release_version, protocol_version
         FROM current_release_pairs
       ) AS canonical_release_pairs
       ORDER BY release_version COLLATE "C" NULLS FIRST,
                protocol_version COLLATE "C" NULLS FIRST`,
      []
    );
    const currentPairs = rows.map((row, index) =>
      pairFrom(
        { releaseVersion: row.release_version, protocolVersion: row.protocol_version },
        `current release pair ${index}`
      )
    );
    if (currentPairs.length === 0) {
      throw new Error("current release set is empty");
    }
    const currentDigest = sha256(canonicalJson(currentPairs));
    const catalogPairKeys = new Set(verified.releasePairs.map((pair) => JSON.stringify(pair)));
    if (currentPairs.some((pair) => !catalogPairKeys.has(JSON.stringify(pair)))) {
      throw new Error("current release pair is outside the reviewed catalog");
    }
    await input.client.query("COMMIT");
    transactionOpen = false;
    const held: D1ExpandPreflightStatus = {
      status: "held",
      lockPairSha256: verified.lockPairSha256,
      catalogReleaseSetSha256: verified.releaseSetSha256,
      catalogReleasePairCount: verified.releasePairs.length,
      currentReleaseSetSha256: currentDigest,
      currentReleasePairCount: currentPairs.length,
    };
    input.onStatus?.(held);
    await input.waitForRelease();
    await input.client.query("SELECT pg_advisory_unlock(hashtext('exomem-hosted-alpha-cohort'))");
    locked = false;
    return { ...held, status: "released" };
  } catch (error) {
    if (transactionOpen) {
      await input.client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    if (locked) {
      await input.client
        .query("SELECT pg_advisory_unlock(hashtext('exomem-hosted-alpha-cohort'))")
        .catch(() => undefined);
    }
  }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function waitForReleaseLine(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line === "release") {
      lines.close();
      return;
    }
    throw new Error("release acknowledgement is invalid");
  }
  throw new Error("release acknowledgement was not received");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const lockPairPath = argument("--lock-pair");
  const expectedLockPairSha256 = argument("--lock-pair-sha256");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await holdD1ExpandPreflight({
      client,
      deploymentLockPairBytes: await readFile(lockPairPath),
      expectedLockPairSha256,
      waitForRelease: waitForReleaseLine,
      onStatus: (status) => process.stdout.write(`${JSON.stringify(status)}\n`),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("D1 expand preflight failed\n");
    process.exitCode = 1;
  });
}
