import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import type { GatewayTarget } from "../db";
import { ExomemHostedError } from "../errors";
import {
  clearContractCacheForTests,
  hasForbiddenGatewayHeaders,
  hasReservedSelector,
  routeExomemCommand,
} from "../gateway";
import { SensitiveSecret, type SecretEnvelope } from "../security";
import { exomemHostedContractFixture as agentFixture0340 } from "../agent-contract-fixture-0-34-0";
import { exomemHostedContractFixture as agentFixture0350 } from "../agent-contract-fixture-0-35-0";
import { exomemHostedContractFixture as agentFixture0392 } from "../agent-contract-fixture-0-39-2";
import { exomemHostedContractFixture as agentFixture0490 } from "../agent-contract-fixture-0-49-0";
import { exomemHostedContractFixture as agentFixture0631 } from "../agent-contract-fixture";
import { exomemHostedContractFixture as agentFixture0572 } from "../agent-contract-fixture-0-57-2";
import { exomemHostedContractFixture as agentFixture0500 } from "../agent-contract-fixture-0-50-0";
import { exomemHostedContractFixture as agentFixture0541 } from "../agent-contract-fixture-0-54-1";
import fullContract0340 from "./gateway-contract-0-34-0.json";
import fullContract0350 from "./gateway-contract-0-35-0.json";
import fullContract0500 from "./gateway-contract-0-50-0.json";
import fullContract0631 from "./gateway-contract-0-63-1.json";

const USER_A = "018f2d91-7c42-7000-8000-000000000071";
const TENANT_A = "018f2d91-7c42-7000-8000-000000000072";
const USER_B = "018f2d91-7c42-7000-8000-000000000073";
const TENANT_B = "018f2d91-7c42-7000-8000-000000000074";

// Generated from Exomem 0.34.0 commit 253c9aa365d7afd8829dc7843f1cac53353ac825.
const CANONICAL_CONTRACT = fullContract0340 as TestContract;
const FULL_CONTRACT_0340 = fullContract0340 as TestContract;
const FULL_CONTRACT_0350 = fullContract0350 as TestContract;
const FULL_CONTRACT_0500 = fullContract0500 as TestContract;
const FULL_CONTRACT_0631 = fullContract0631 as TestContract;
const LIVE_HOSTED_CONTRACT = {
  profile: agentFixture0340.compatibility.profile,
  sourceRelease: agentFixture0340.sourceRelease,
  protocolVersion: agentFixture0340.compatibility.agent_contract.protocol_version,
  commandFingerprint: agentFixture0340.compatibility.command_surface_sha256,
  schemaDigest: agentFixture0340.compatibility.schema_contract_sha256,
  compatibilityDigest: agentFixture0340.compatibility.compatibility_sha256,
};
const CANDIDATE_HOSTED_CONTRACT = {
  profile: agentFixture0350.compatibility.profile,
  sourceRelease: agentFixture0350.sourceRelease,
  protocolVersion: agentFixture0350.compatibility.agent_contract.protocol_version,
  commandFingerprint: agentFixture0350.compatibility.command_surface_sha256,
  schemaDigest: agentFixture0350.compatibility.schema_contract_sha256,
  compatibilityDigest: agentFixture0350.compatibility.compatibility_sha256,
};
// The release the hosted deployment lock pins. A cell whose release has no
// catalog entry resolves zero fixtures and every command fails closed with
// PROTOCOL_MISMATCH, so the deployed release must always be represented here.
const DEPLOYED_HOSTED_CONTRACT = {
  profile: agentFixture0392.compatibility.profile,
  sourceRelease: agentFixture0392.sourceRelease,
  protocolVersion: agentFixture0392.compatibility.agent_contract.protocol_version,
  commandFingerprint: agentFixture0392.compatibility.command_surface_sha256,
  schemaDigest: agentFixture0392.compatibility.schema_contract_sha256,
  compatibilityDigest: agentFixture0392.compatibility.compatibility_sha256,
};
const RETAINED_0500_HOSTED_CONTRACT = {
  profile: agentFixture0500.compatibility.profile,
  sourceRelease: agentFixture0500.sourceRelease,
  protocolVersion: agentFixture0500.compatibility.agent_contract.protocol_version,
  commandFingerprint: agentFixture0500.compatibility.command_surface_sha256,
  schemaDigest: agentFixture0500.compatibility.schema_contract_sha256,
  compatibilityDigest: agentFixture0500.compatibility.compatibility_sha256,
};
const RETAINED_0541_HOSTED_CONTRACT = {
  profile: agentFixture0541.compatibility.profile,
  sourceRelease: agentFixture0541.sourceRelease,
  protocolVersion: agentFixture0541.compatibility.agent_contract.protocol_version,
  commandFingerprint: agentFixture0541.compatibility.command_surface_sha256,
  schemaDigest: agentFixture0541.compatibility.schema_contract_sha256,
  compatibilityDigest: agentFixture0541.compatibility.compatibility_sha256,
};
const RETAINED_0572_HOSTED_CONTRACT = {
  profile: agentFixture0572.compatibility.profile,
  sourceRelease: agentFixture0572.sourceRelease,
  protocolVersion: agentFixture0572.compatibility.agent_contract.protocol_version,
  commandFingerprint: agentFixture0572.compatibility.command_surface_sha256,
  schemaDigest: agentFixture0572.compatibility.schema_contract_sha256,
  compatibilityDigest: agentFixture0572.compatibility.compatibility_sha256,
};
const CURRENT_HOSTED_CONTRACT = {
  profile: agentFixture0631.compatibility.profile,
  sourceRelease: agentFixture0631.sourceRelease,
  protocolVersion: agentFixture0631.compatibility.agent_contract.protocol_version,
  commandFingerprint: agentFixture0631.compatibility.command_surface_sha256,
  schemaDigest: agentFixture0631.compatibility.schema_contract_sha256,
  compatibilityDigest: agentFixture0631.compatibility.compatibility_sha256,
};

const PUBLISHED_AGENT_CONTRACTS = new Map<string, Record<string, unknown>>(
  [
    agentFixture0340,
    agentFixture0350,
    agentFixture0392,
    agentFixture0490,
    agentFixture0500,
    agentFixture0541,
    agentFixture0572,
    agentFixture0631,
  ].map((fixture) => [
    fixture.sourceRelease,
    fixture.compatibility.agent_contract as unknown as Record<string, unknown>,
  ])
);

// Deliberately re-derived from the publisher's rule -- Python
// `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)`, so keys
// sort by CODE POINT -- rather than imported from `gateway.ts`. A test that borrows
// the implementation it is checking cannot detect that implementation drifting.
function publisherCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publisherCanonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, publisherCanonical(nested)])
  );
}

// What a cell actually serves at `/private/exomem/v1/agent/<profile>/contract`:
// the published contract, plus `exomem_release`, re-digested WITH that release
// included. Restating `hosted.schemaDigest` as the served `digest.value` -- which
// this suite used to do -- makes the stub agree with the assertion by construction
// and blesses the very mismatch the endpoint exists to catch. That is how exomem's
// release-independent `schema_contract_sha256` (#345) shipped past a green suite
// and left every hosted tool call failing CELL_PROTOCOL_MISMATCH in production.
function cellAgentContractBody<T extends { sourceRelease: string }>(
  hosted: T
): Record<string, unknown> {
  const published = PUBLISHED_AGENT_CONTRACTS.get(hosted.sourceRelease);
  assert.ok(published, `no published agent contract fixture for ${hosted.sourceRelease}`);
  const runtimeBase: Record<string, unknown> = { exomem_release: hosted.sourceRelease };
  for (const [key, value] of Object.entries(published)) {
    if (key !== "digest") runtimeBase[key] = value;
  }
  return {
    ...runtimeBase,
    digest: {
      algorithm: "sha256",
      value: createHash("sha256")
        .update(JSON.stringify(publisherCanonical(runtimeBase)), "utf8")
        .digest("hex"),
    },
  };
}

type TestContract = {
  schema_version: number;
  protocol_version: string;
  exomem_release: string;
  commands: Array<{
    name: string;
    params: Array<{ name: string; type: string; required: boolean }>;
    read_only: boolean;
    mode: "read" | "write";
    tier: number;
    capability: string;
    guarded_fields: string[];
  }>;
  digest: { algorithm: "sha256"; value: string };
  [key: string]: unknown;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)])
  );
}

function contract(tamperDigest = false): TestContract {
  const value = structuredClone(CANONICAL_CONTRACT);
  if (tamperDigest) value.digest.value = "0".repeat(64);
  return value;
}

function alteredContract(mutate: (value: TestContract) => void): TestContract {
  const value = contract();
  mutate(value);
  const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  value.digest.value = createHash("sha256")
    .update(JSON.stringify(canonicalize(unsigned)))
    .digest("hex");
  return value;
}

function target(input: {
  userId: string;
  tenantId: string;
  cellId: string;
  endpoint: string;
  capabilities?: string[];
  hosted?: {
    profile: string;
    sourceRelease: string;
    protocolVersion: string;
    commandFingerprint: string;
    schemaDigest: string;
    compatibilityDigest: string;
  };
  releaseVersion?: string;
}): GatewayTarget {
  return {
    userId: input.userId,
    tenantId: input.tenantId,
    tenantStatus: "active",
    tenantDesiredState: "running",
    cellId: input.cellId,
    cellLifecycleState: "active",
    cellRoutingState: "bound",
    protocolVersion: "1",
    releaseVersion: input.releaseVersion ?? "0.34.0",
    credentialVersion: 1,
    credentialCiphertext: { value: `credential-${input.cellId}` },
    endpointCiphertext: { value: input.endpoint },
    entitlementSource: "complimentary",
    entitlementSourceState: "complimentary_active",
    entitlementEffectiveState: "active",
    capabilities: input.capabilities ?? ["capture", "recall", "export"],
    resourceLimits: {
      storageBytes: 1024,
      uploadBytes: 512,
      workerCount: 0,
    },
    manuallySuspended: false,
    hostedProfile: input.hosted?.profile,
    hostedSourceRelease: input.hosted?.sourceRelease,
    hostedProtocolVersion: input.hosted?.protocolVersion,
    hostedCommandFingerprint: input.hosted?.commandFingerprint,
    hostedContractDigest: input.hosted?.schemaDigest,
    hostedCompatibilityDigest: input.hosted?.compatibilityDigest,
  };
}

function decrypt(envelope: SecretEnvelope): SensitiveSecret {
  return new SensitiveSecret(String((envelope as unknown as { value: string }).value));
}

beforeEach(clearContractCacheForTests);

describe("registry-derived Exomem gateway", () => {
  it("routes the live 0.34 full contract instead of the historical 0.24 singleton", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-034",
      endpoint: "https://cell-034.internal/",
      releaseVersion: "0.34.0",
    });
    await assert.doesNotReject(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "live release" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(FULL_CONTRACT_0340)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      })
    );
  });

  it("routes a 0.35 candidate against its own full contract", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-035",
      endpoint: "https://cell-035.internal/",
      releaseVersion: "0.35.0",
    });
    await assert.doesNotReject(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "candidate release" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(FULL_CONTRACT_0350)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      })
    );
  });

  it("keeps live and candidate agent contracts paired with their own full fixtures", async () => {
    for (const [releaseVersion, hosted] of [
      ["0.34.0", LIVE_HOSTED_CONTRACT],
      ["0.35.0", CANDIDATE_HOSTED_CONTRACT],
      ["0.39.2", DEPLOYED_HOSTED_CONTRACT],
      [
        "0.49.0",
        {
          profile: agentFixture0490.compatibility.profile,
          sourceRelease: agentFixture0490.sourceRelease,
          protocolVersion: agentFixture0490.compatibility.agent_contract.protocol_version,
          commandFingerprint: agentFixture0490.compatibility.command_surface_sha256,
          schemaDigest: agentFixture0490.compatibility.schema_contract_sha256,
          compatibilityDigest: agentFixture0490.compatibility.compatibility_sha256,
        },
      ],
      ["0.50.0", RETAINED_0500_HOSTED_CONTRACT],
      ["0.54.1", RETAINED_0541_HOSTED_CONTRACT],
      ["0.57.2", RETAINED_0572_HOSTED_CONTRACT],
      ["0.63.1", CURRENT_HOSTED_CONTRACT],
    ] as const) {
      const row = target({
        userId: USER_A,
        tenantId: TENANT_A,
        cellId: `cell-${releaseVersion}`,
        endpoint: `https://cell-${releaseVersion}.internal/`,
        releaseVersion,
        hosted,
      });
      await assert.doesNotReject(
        routeExomemCommand({
          session: { userId: USER_A, tenantId: TENANT_A },
          commandName: "ask_memory",
          args: { query: releaseVersion },
          command: {
            name: "ask_memory",
            params: [{ name: "query", type: "str", required: false }],
            read_only: true,
            mode: "read",
            tier: 1,
            capability: "core",
            guarded_fields: [],
          },
          hostedContract: hosted,
          dependencies: {
            resolveTarget: async () => row,
            fetch: async (input) =>
              String(input).endsWith("/contract")
                ? Response.json(cellAgentContractBody(hosted))
                : Response.json({ success: true, data: {} }),
            expectedProtocol: "1",
            decrypt,
            principalScope: () => "A".repeat(43),
          },
        })
      );
    }
  });

  it("routes 0.63.1 through the authoritative v4 private profile", async () => {
    const hosted = CURRENT_HOSTED_CONTRACT;
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-0631-v4",
      endpoint: "https://cell-0631-v4.internal/",
      releaseVersion: hosted.sourceRelease,
      hosted,
    });
    const urls: string[] = [];
    await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "ask_memory",
      args: { query: "v4 route" },
      command: {
        name: "ask_memory",
        params: [{ name: "query", type: "str", required: true }],
        read_only: true,
        mode: "read",
        tier: 1,
        capability: "core",
        guarded_fields: [],
      },
      hostedContract: hosted,
      dependencies: {
        resolveTarget: async () => row,
        fetch: async (input) => {
          const url = String(input);
          urls.push(url);
          return url.endsWith("/contract")
            ? Response.json(cellAgentContractBody(hosted))
            : Response.json({ success: true, data: {} });
        },
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });
    assert.deepEqual(
      urls.map((url) => new URL(url).pathname),
      [
        "/private/exomem/v1/agent/hosted-alpha-agent-v4/contract",
        "/private/exomem/v1/agent/hosted-alpha-agent-v4/command/ask_memory",
      ]
    );
    assert.equal(FULL_CONTRACT_0631.commands.length >= 25, true);
  });

  it("compares the cell's PUBLISHED agent digest, not the release-inclusive one it serves", async () => {
    // The regression this pins: a cell advertises `digest.value` computed WITH
    // `exomem_release` in the base, while the candidate pins the release-independent
    // `schema_contract_sha256` (exomem #345). Comparing those two directly is a
    // comparison between different quantities, and it failed for every release built
    // after 2026-07-27 -- 0.54.1 and 0.57.2 included -- so no hosted tool call could
    // succeed in production. Revert `publishedAgentContractDigest` to `digest?.value`
    // and this case goes red.
    const hosted = CURRENT_HOSTED_CONTRACT;
    const body = cellAgentContractBody(hosted);
    assert.notEqual(
      (body.digest as { value: string }).value,
      hosted.schemaDigest,
      "the served digest must differ from the pinned one, or this case proves nothing"
    );

    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-published-digest",
      endpoint: "https://cell-published-digest.internal/",
      releaseVersion: hosted.sourceRelease,
      hosted,
    });
    const command = {
      name: "ask_memory",
      params: [{ name: "query", type: "str", required: false }],
      read_only: true,
      mode: "read" as const,
      tier: 1,
      capability: "core",
      guarded_fields: [],
    };
    const route = (contract: Record<string, unknown>) =>
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "published digest" },
        command,
        hostedContract: hosted,
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contract)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      });

    await assert.doesNotReject(route(body));

    // Still fails closed: a cell whose contract body has drifted is refused even
    // though it reports the four scalar fields correctly. Without this half the fix
    // could have been "drop the digest check" and the test would not notice.
    await assert.rejects(
      route({ ...body, commands: [] }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
  });

  it("routes the current 0.50.0 release", async () => {
    // Until this fixture existed the catalog stopped at 0.39.2, so a cell running
    // the locked runtime matched zero entries and every command failed closed.
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-0500",
      endpoint: "https://cell-0500.internal/",
      releaseVersion: "0.50.0",
    });
    await assert.doesNotReject(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "deployed release" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(FULL_CONTRACT_0500)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      })
    );
  });

  it("rejects a historical 0.24 full fixture paired with the live 0.34 agent", async () => {
    const hosted = LIVE_HOSTED_CONTRACT;
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-split",
      endpoint: "https://cell-split.internal/",
      releaseVersion: "0.24.0",
      hosted,
    });
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "split unit" },
        command: {
          name: "ask_memory",
          params: [{ name: "query", type: "str", required: false }],
          read_only: true,
          mode: "read",
          tier: 1,
          capability: "core",
          guarded_fields: [],
        },
        hostedContract: hosted,
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(cellAgentContractBody(hosted))
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
  });

  it("rejects an unsupported profile with otherwise exact live 0.34 locks", async () => {
    const hosted = { ...LIVE_HOSTED_CONTRACT, profile: "unsupported-agent-profile" };
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-profile-split",
      endpoint: "https://cell-profile-split.internal/",
      hosted,
    });
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "profile split" },
        command: {
          name: "ask_memory",
          params: [{ name: "query", type: "str", required: false }],
          read_only: true,
          mode: "read",
          tier: 1,
          capability: "core",
          guarded_fields: [],
        },
        hostedContract: hosted,
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(cellAgentContractBody(hosted))
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
  });

  it("accepts the exact hosted private profile-contract response shape", async () => {
    const hosted = LIVE_HOSTED_CONTRACT;
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
      hosted,
    });
    const result = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "ask_memory",
      args: { query: "private shape" },
      command: {
        name: "ask_memory",
        params: [{ name: "query", type: "str", required: true }],
        read_only: true,
        mode: "read",
        tier: 1,
        capability: "core",
        guarded_fields: [],
      },
      hostedContract: hosted,
      dependencies: {
        resolveTarget: async () => row,
        fetch: async (input) =>
          String(input).endsWith("/contract")
            ? Response.json(cellAgentContractBody(hosted))
            : Response.json({ success: true, data: {} }),
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });
    assert.deepEqual(result.body, { success: true, data: {} });
  });

  it("rejects browser attempts to supply Cloudflare Access service credentials", () => {
    for (const name of ["CF-Access-Client-Id", "CF-Access-Client-Secret"]) {
      assert.equal(hasForbiddenGatewayHeaders(new Headers({ [name]: "browser-value" })), true);
    }
  });

  it("rejects release selectors in public headers and cookies without rejecting the bearer", () => {
    assert.equal(
      hasForbiddenGatewayHeaders(
        new Headers({ authorization: "Bearer opaque", "candidate-id": "candidate-b" })
      ),
      true
    );
    assert.equal(
      hasForbiddenGatewayHeaders(
        new Headers({ authorization: "Bearer opaque", "source-release": "0.35.0" })
      ),
      true
    );
    assert.equal(
      hasForbiddenGatewayHeaders(new Headers({ cookie: "session=safe; assignment_generation=7" })),
      true
    );
    assert.equal(
      hasForbiddenGatewayHeaders(
        new Headers({ cookie: `session=safe; contractDigest=${"a".repeat(64)}` })
      ),
      true
    );
    assert.equal(
      hasForbiddenGatewayHeaders(
        new Headers({ authorization: "Bearer opaque", cookie: "session=safe" })
      ),
      false
    );
  });

  it("keeps identical paths and idempotency keys isolated to the mapped cell", async () => {
    const targets = new Map([
      [
        TENANT_A,
        target({
          userId: USER_A,
          tenantId: TENANT_A,
          cellId: "cell-a",
          endpoint: "https://cell-a.internal/",
        }),
      ],
      [
        TENANT_B,
        target({
          userId: USER_B,
          tenantId: TENANT_B,
          cellId: "cell-b",
          endpoint: "https://cell-b.internal/",
        }),
      ],
    ]);
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      if (url.endsWith("/contract")) return Response.json(contract());
      const cell = new URL(url).hostname.startsWith("cell-a") ? "cell-a" : "cell-b";
      return Response.json({ success: true, data: { cell } });
    };
    const resolveTarget = async (session: { tenantId: string }) =>
      targets.get(session.tenantId) ?? null;
    const access = {
      selectedVersion: "active" as const,
      active: {
        clientId: new SensitiveSecret("gateway-client-id.access"),
        clientSecret: new SensitiveSecret("gateway-client-secret-sentinel"),
      },
      previous: null,
    };

    const first = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Same", content: "same path" },
      idempotencyKey: "same-public-key",
      dependencies: {
        resolveTarget,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
        access,
      },
    });
    const second = await routeExomemCommand({
      session: { userId: USER_B, tenantId: TENANT_B },
      commandName: "remember",
      args: { title: "Same", content: "same path" },
      idempotencyKey: "same-public-key",
      dependencies: {
        resolveTarget,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "B".repeat(43),
        access,
      },
    });

    assert.deepEqual(first.body, { success: true, data: { cell: "cell-a" } });
    assert.deepEqual(second.body, { success: true, data: { cell: "cell-b" } });
    const commandCalls = calls.filter((call) => call.url.includes("/command/"));
    assert.equal(commandCalls.length, 2);
    assert.match(commandCalls[0].url, /\/private\/exomem\/v1\/command\//);
    assert.equal(commandCalls[0].headers.get("x-exomem-cell-id"), "cell-a");
    assert.equal(commandCalls[1].headers.get("x-exomem-cell-id"), "cell-b");
    assert.equal(commandCalls[0].headers.get("idempotency-key"), "same-public-key");
    assert.equal(commandCalls[1].headers.get("idempotency-key"), "same-public-key");
    assert.equal(commandCalls[0].headers.get("cf-access-client-id"), "gateway-client-id.access");
    assert.equal(
      commandCalls[0].headers.get("cf-access-client-secret"),
      "gateway-client-secret-sentinel"
    );
    assert.notEqual(
      commandCalls[0].headers.get("x-exomem-principal-scope"),
      commandCalls[1].headers.get("x-exomem-principal-scope")
    );
  });

  it("rejects nested routing selectors before resolving or contacting a cell", async () => {
    let resolutions = 0;
    let calls = 0;
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: {
          title: "selector",
          content: "safe",
          metadata: { tenant_id: TENANT_B },
        },
        idempotencyKey: "selector-test",
        dependencies: {
          resolveTarget: async () => {
            resolutions += 1;
            return null;
          },
          fetch: async () => {
            calls += 1;
            return Response.json({});
          },
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "HOSTED_SELECTOR_REJECTED"
    );
    assert.equal(resolutions, 0);
    assert.equal(calls, 0);
  });

  it("normalizes camel-case authority selectors", () => {
    assert.equal(hasReservedSelector({ tenantId: TENANT_A }), true);
    assert.equal(hasReservedSelector({ nested: { cellId: "cell-a" } }), true);
    assert.equal(hasReservedSelector({ auth: { sessionId: "other" } }), true);
    assert.equal(hasReservedSelector({ nested: { candidateId: "candidate-b" } }), true);
    assert.equal(hasReservedSelector({ assignmentGeneration: 2 }), true);
    assert.equal(hasReservedSelector({ stagedClientReleaseId: "stage-b" }), true);
    assert.equal(hasReservedSelector({ artifactSha256: "a".repeat(64) }), true);
    assert.equal(hasReservedSelector({ releaseVersion: "0.35.0" }), true);
    assert.equal(hasReservedSelector({ schemaDigest: "a".repeat(64) }), true);
    assert.equal(hasReservedSelector({ compatibilityDigest: "b".repeat(64) }), true);
    assert.equal(hasReservedSelector({ sourceRelease: "0.35.0" }), true);
    assert.equal(hasReservedSelector({ boundCellId: "cell-b" }), true);
    assert.equal(hasReservedSelector({ targetCandidateId: "candidate-b" }), true);
    assert.equal(hasReservedSelector({ contractDigest: "a".repeat(64) }), true);
    assert.equal(hasReservedSelector({ commandFingerprint: "b".repeat(64) }), true);
  });

  it("retries a lost mutation acknowledgement only against the same cell", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let commandCalls = 0;
    const seenHeaders: Headers[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/contract")) return Response.json(contract());
      commandCalls += 1;
      seenHeaders.push(new Headers(init?.headers));
      if (commandCalls === 1) throw new Error("lost acknowledgement");
      return Response.json({ success: true, data: { replayed: true } });
    };
    const result = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Retry", content: "once" },
      idempotencyKey: "retry-once",
      dependencies: {
        resolveTarget: async () => row,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });
    assert.equal(commandCalls, 2);
    assert.deepEqual(result.body, { success: true, data: { replayed: true } });
    assert.equal(
      seenHeaders[0].get("x-exomem-request-id"),
      seenHeaders[1].get("x-exomem-request-id")
    );
    assert.equal(seenHeaders[0].get("idempotency-key"), "retry-once");
  });

  it("retries a reset 200 response body against the same cell and request identity", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let commandCalls = 0;
    const seenHeaders: Headers[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/contract")) return Response.json(contract());
      commandCalls += 1;
      seenHeaders.push(new Headers(init?.headers));
      if (commandCalls === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("stream reset after headers"));
            },
          }),
          { status: 200 }
        );
      }
      return Response.json({ success: true, data: { replayed: true } });
    };

    const result = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Retry", content: "lost body acknowledgement" },
      idempotencyKey: "retry-reset-body",
      dependencies: {
        resolveTarget: async () => row,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });

    assert.deepEqual(result.body, { success: true, data: { replayed: true } });
    assert.equal(commandCalls, 2);
    assert.equal(
      seenHeaders[0].get("x-exomem-request-id"),
      seenHeaders[1].get("x-exomem-request-id")
    );
    assert.equal(seenHeaders[1].get("idempotency-key"), "retry-reset-body");
  });

  it("does not retry a malformed successful command envelope", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let commandCalls = 0;

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "invalid response is not transport failure" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) => {
            if (String(input).endsWith("/contract")) return Response.json(contract());
            commandCalls += 1;
            return new Response("not json", { status: 200 });
          },
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );
    assert.equal(commandCalls, 1);
  });

  it("does not begin a retry after the command's absolute deadline", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let now = 0;
    let commandCalls = 0;

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "one bounded deadline" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) => {
            if (String(input).endsWith("/contract")) return Response.json(contract());
            commandCalls += 1;
            now = 10_001;
            throw new Error("deadline consumed");
          },
          expectedProtocol: "1",
          now: () => now,
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) => error instanceof ExomemHostedError && error.code === "CELL_UNAVAILABLE"
    );
    assert.equal(commandCalls, 1);
  });

  it("stops reading an oversized streamed command response at the configured bound", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let pulls = 0;
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls === 128) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "bounded response" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contract())
              : new Response(oversized, { status: 200 }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 66, `read ${pulls} chunks after crossing the 4 MiB bound`);
  });

  it("cancels a retryable error body without draining an unbounded stream", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let pulls = 0;
    let cancelled = false;
    let commandCalls = 0;
    const fetchMock: typeof fetch = async (input) => {
      if (String(input).endsWith("/contract")) return Response.json(contract());
      commandCalls += 1;
      if (commandCalls === 2) return Response.json({ success: true, data: { replayed: true } });
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(chunk);
            if (pulls === 128) controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503 }
      );
    };

    const result = await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "remember",
      args: { title: "Retry", content: "bounded error body" },
      idempotencyKey: "bounded-error-body",
      dependencies: {
        resolveTarget: async () => row,
        fetch: fetchMock,
        expectedProtocol: "1",
        decrypt,
        principalScope: () => "A".repeat(43),
      },
    });
    assert.deepEqual(result.body, { success: true, data: { replayed: true } });
    assert.equal(commandCalls, 2);
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2, `drained ${pulls} chunks before retrying`);
  });

  it("cancels an unsuccessful contract body without draining an unbounded stream", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const chunk = new Uint8Array(64 * 1024).fill(0x78);
    let pulls = 0;
    let cancelled = false;
    const unbounded = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "bounded contract error" },
        dependencies: {
          resolveTarget: async () => row,
          fetch: async () => new Response(unbounded, { status: 503 }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) => error instanceof ExomemHostedError && error.code === "CELL_UNAVAILABLE"
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2, `drained ${pulls} contract chunks before failing closed`);
  });

  it("fails closed for a tampered contract and absent capabilities", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
      capabilities: ["recall"],
    });
    const dependencies = {
      resolveTarget: async () => row,
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
    };
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "anything" },
        dependencies: {
          ...dependencies,
          fetch: async () => Response.json(contract(true)),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );

    clearContractCacheForTests();
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: { title: "Denied", content: "no capture" },
        idempotencyKey: "denied-write",
        dependencies: {
          ...dependencies,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contract())
              : Response.json({ success: true, data: {} }),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "EXOMEM_ENTITLEMENT_DENIED"
    );
  });

  it("rejects contradictory read metadata before using it for retry or mutation policy", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const contradictory = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "ask_memory");
      assert.ok(command);
      command.read_only = false;
    });

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "anything" },
        idempotencyKey: "contradictory-read-mode",
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(contradictory)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_RESPONSE_INVALID"
    );
  });

  it("rejects self-consistent semantic drift from the pinned 0.34.0 registry", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    const drifted = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "remember");
      assert.ok(command);
      command.guarded_fields = [];
    });
    assert.notEqual(drifted.digest.value, CANONICAL_CONTRACT.digest.value);

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "remember",
        args: { title: "Drift", content: "must not execute" },
        idempotencyKey: "semantic-drift",
        dependencies: {
          resolveTarget: async () => row,
          fetch: async (input) =>
            String(input).endsWith("/contract")
              ? Response.json(drifted)
              : Response.json({ success: true, data: {} }),
          expectedProtocol: "1",
          decrypt,
          principalScope: () => "A".repeat(43),
        },
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
  });

  it("does not let a cached contract hide an immediately altered digest", async () => {
    const row = target({
      userId: USER_A,
      tenantId: TENANT_A,
      cellId: "cell-a",
      endpoint: "https://cell-a.internal/",
    });
    let contractCalls = 0;
    let commandCalls = 0;
    const drifted = alteredContract((value) => {
      const command = value.commands.find((candidate) => candidate.name === "ask_memory");
      assert.ok(command);
      command.capability = "unexpected-capability";
    });
    const fetchMock: typeof fetch = async (input) => {
      if (String(input).endsWith("/contract")) {
        contractCalls += 1;
        return Response.json(contractCalls === 1 ? contract() : drifted);
      }
      commandCalls += 1;
      return Response.json({ success: true, data: {} });
    };
    const dependencies = {
      resolveTarget: async () => row,
      fetch: fetchMock,
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
    };

    await routeExomemCommand({
      session: { userId: USER_A, tenantId: TENANT_A },
      commandName: "ask_memory",
      args: { query: "first" },
      dependencies,
    });
    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "ask_memory",
        args: { query: "second" },
        dependencies,
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_PROTOCOL_MISMATCH"
    );
    assert.equal(contractCalls, 2);
    assert.equal(commandCalls, 1);
  });

  it("keeps adoption_studio on generic dispatch while transfer verbs stay intercepted", async () => {
    let resolutions = 0;
    const dependencies = {
      resolveTarget: async () => {
        resolutions += 1;
        return null;
      },
      fetch: async () => Response.json({}),
      expectedProtocol: "1",
      decrypt,
      principalScope: () => "A".repeat(43),
    };

    for (const commandName of ["transfer_artifact", "adopt_vault"]) {
      await assert.rejects(
        routeExomemCommand({
          session: { userId: USER_A, tenantId: TENANT_A },
          commandName,
          args: {},
          idempotencyKey: "intercept-check",
          dependencies,
        }),
        (error: unknown) =>
          error instanceof ExomemHostedError && error.code === "HOSTED_INTERCEPT_REQUIRED"
      );
    }
    assert.equal(resolutions, 0);

    await assert.rejects(
      routeExomemCommand({
        session: { userId: USER_A, tenantId: TENANT_A },
        commandName: "adoption_studio",
        args: { action: "status", run_id: "run-1" },
        idempotencyKey: "generic-dispatch-check",
        dependencies,
      }),
      (error: unknown) =>
        error instanceof ExomemHostedError && error.code === "CELL_MAPPING_MISSING"
    );
    assert.equal(resolutions, 1);
  });
});
