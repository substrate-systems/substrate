import assert from "node:assert/strict";
import { describe, it } from "node:test";
import acceptanceFixture from "./fixtures/hosted-paired-acceptance-v1.json";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { handleHostedMcpRequest } from "../mcp";
import type { GatewayResult } from "../gateway";
import {
  InMemoryLifecycleStore,
  LifecycleReconciler,
  expectedCellConfiguration,
} from "../reconciler";
import { FakeCellProvisioner } from "../provisioner";
import type { ActiveOAuthAccessToken } from "../oauth-store";

const OWNER = "018f2d91-7c42-7000-8000-000000000071";
const TENANT = "018f2d91-7c42-7000-8000-000000000072";
const RESOURCE = "https://substratesystems.io/api/exomem/mcp/v1";
const CLAUDE_TOKEN = "c".repeat(43);
const OPENAI_TOKEN = "o".repeat(43);
const REVOKED_TOKEN = "r".repeat(43);

type AcceptanceFixture = {
  schema_version: number;
  run_id: string;
  required_counts: Record<
    "cell" | "entitlement" | "identity" | "operation" | "tenant" | "volume",
    number
  >;
  required_operations: string[];
  tenant_identity: string;
  exomem_compatibility: {
    profile: string;
    source_commit: string;
    compatibility_sha256: string;
    schema_contract_sha256: string;
    command_surface_sha256: string;
  };
  local_evidence: { promotable: boolean; real_client_ran: boolean };
};

const fixture = acceptanceFixture as AcceptanceFixture;

function access(clientId: string, familyId: string): ActiveOAuthAccessToken {
  return {
    familyId,
    grantId: `grant-${familyId}`,
    clientId,
    resource: RESOURCE,
    scopes: ["exomem.read", "exomem.write"],
    userId: OWNER,
    tenantId: TENANT,
  };
}

function request(token: string, method: string, params: Record<string, unknown> = {}): Request {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
  });
}

async function converge(reconciler: LifecycleReconciler, tenantId = TENANT): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1)
    await reconciler.reconcileOne({ owner: `paired-acceptance-${attempt}`, tenantId });
}

function routed(data: Record<string, unknown>): GatewayResult {
  return { status: 200, requestId: "local-paired-acceptance", body: { success: true, data } };
}

describe("Hosted Exomem paired acceptance fixture", () => {
  it("pins the paired run identity to the exact Exomem compatibility contract", () => {
    assert.equal(fixture.schema_version, 1);
    assert.equal(fixture.run_id, "hosted-client-plugins-v1");
    assert.equal(fixture.tenant_identity, "paired-runtime-evidence");
    assert.deepEqual(fixture.required_counts, {
      cell: 1,
      entitlement: 1,
      identity: 1,
      operation: 1,
      tenant: 1,
      volume: 1,
    });
    assert.deepEqual(fixture.required_operations, [
      "native_install",
      "authorization",
      "tool_discovery",
      "content_recall",
      "citation",
      "durable_capture",
      "fresh_chat_recall",
    ]);
    assert.equal(
      fixture.exomem_compatibility.profile,
      exomemHostedContractFixture.compatibility.profile
    );
    assert.equal(
      fixture.exomem_compatibility.source_commit,
      exomemHostedContractFixture.sourceCommit
    );
    assert.equal(
      fixture.exomem_compatibility.compatibility_sha256,
      exomemHostedContractFixture.compatibility.compatibility_sha256
    );
    assert.equal(
      fixture.exomem_compatibility.schema_contract_sha256,
      exomemHostedContractFixture.compatibility.schema_contract_sha256
    );
    assert.equal(
      fixture.exomem_compatibility.command_surface_sha256,
      exomemHostedContractFixture.compatibility.command_surface_sha256
    );
    assert.equal(fixture.local_evidence.promotable, false);
    assert.equal(fixture.local_evidence.real_client_ran, false);
  });

  it("exercises the local paired journey without producing promotion evidence", async () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const store = new InMemoryLifecycleStore({ now: () => now });
    const provider = new FakeCellProvisioner({ now: () => now });
    const reconciler = new LifecycleReconciler({
      store,
      provisioner: provider,
      config: expectedCellConfiguration({
        protocolVersion: "1",
        releaseVersion: "0.33.0",
        workerPolicy: { workerCount: 0, semantic: false, media: false },
      }),
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, 0x71),
      envelopeKey: Buffer.alloc(32, 0x72),
      terminateBilling: async (tenantId) => ({
        tenantId,
        userId: OWNER,
        source: "complimentary",
        sourceState: "complimentary_active",
        sourceRevision: null,
        providerEnvironment: null,
        customerRef: null,
        subscriptionRef: null,
        transactionRef: null,
      }),
    });
    const seededContent = "The paired acceptance seed has a citation.";
    let capturedContent: string | null = null;
    const attachments: ActiveOAuthAccessToken[] = [];
    let routedCalls = 0;
    const invoke = async (
      token: string,
      method: string,
      params: Record<string, unknown> = {}
    ): Promise<Record<string, unknown>> => {
      const response = await handleHostedMcpRequest(request(token, method, params), {
        baseUrl: "https://substratesystems.io",
        findAccessToken: async () => {
          if (token === REVOKED_TOKEN) return null;
          const attached =
            token === CLAUDE_TOKEN
              ? access("claude", "claude-family")
              : access("openai", "openai-family");
          attachments.push(attached);
          return attached;
        },
        getLiveContract: async () => ({
          profile: exomemHostedContractFixture.compatibility.profile,
          endpoint: RESOURCE,
          sourceRelease: exomemHostedContractFixture.compatibility.source_release,
          commandFingerprint: exomemHostedContractFixture.compatibility.command_surface_sha256,
          schemaDigest: exomemHostedContractFixture.compatibility.schema_contract_sha256,
          compatibilityDigest: exomemHostedContractFixture.compatibility.compatibility_sha256,
          protocolVersion:
            exomemHostedContractFixture.compatibility.agent_contract.protocol_version,
          contract: exomemHostedContractFixture.compatibility,
        }),
        statusForTenant: async () => {
          const status = store.statusForTenant(TENANT);
          if (status.state === "ready") return { state: "ready", code: "READY", retryable: false };
          if (status.state === "suspended")
            return { state: "suspended", code: "EXOMEM_SUSPENDED", retryable: false };
          if (status.state === "deleted")
            return { state: "deleted", code: "EXOMEM_DELETED", retryable: false };
          return { state: "preparing", code: "TENANT_PREPARING", retryable: true };
        },
        takeRateLimit: async () => true,
        routeCommand: async ({ commandName, args }) => {
          routedCalls += 1;
          if (commandName === "ask_memory")
            return routed({
              hits: capturedContent
                ? [{ title: "Local paired capture", excerpt: capturedContent }]
                : [
                    {
                      title: "Paired acceptance seed",
                      excerpt: seededContent,
                      ref: "Knowledge Base/Seeds/paired-acceptance.md",
                    },
                  ],
            });
          if (commandName === "read_memory")
            return routed({
              content: seededContent,
              citation: "Knowledge Base/Seeds/paired-acceptance.md",
            });
          if (commandName === "remember") {
            capturedContent = String(args.content);
            return routed({ state: "captured" });
          }
          return routed({});
        },
      });
      assert.equal(response.status, token === REVOKED_TOKEN ? 401 : 200);
      return (await response.json()) as Record<string, unknown>;
    };

    const missingBearer = await handleHostedMcpRequest(
      new Request(RESOURCE, { method: "POST", body: "{}" }),
      {
        baseUrl: "https://substratesystems.io",
        takeRateLimit: async () => true,
      }
    );
    assert.equal(missingBearer.status, 401);
    assert.equal(provider.resources.size, 0);
    assert.equal(routedCalls, 0);

    const discovery = await invoke(CLAUDE_TOKEN, "tools/list");
    const discoveryResult = discovery.result as { tools: Array<{ name: string }> };
    assert.equal(
      discoveryResult.tools.some((tool) => tool.name === "ask_memory"),
      true
    );
    assert.equal(
      discoveryResult.tools.some((tool) => tool.name === "remember"),
      true
    );
    assert.equal(provider.resources.size, 0);
    assert.equal(routedCalls, 0);

    const preparing = await invoke(CLAUDE_TOKEN, "tools/call", {
      name: "ask_memory",
      arguments: { query: "paired acceptance seed" },
    });
    assert.match(JSON.stringify(preparing), /TENANT_PREPARING/);
    assert.equal(routedCalls, 0);

    await store.enqueue(TENANT, "provision", "paired-acceptance-provision");
    await converge(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    assert.deepEqual(
      {
        identity: 1,
        tenant: store.tenants.size,
        entitlement: 1,
        operation: store.operations.size,
        cell: store.cells.size,
        volume: provider.resources.size,
      },
      {
        identity: 1,
        tenant: fixture.required_counts.tenant,
        entitlement: fixture.required_counts.entitlement,
        operation: fixture.required_counts.operation,
        cell: fixture.required_counts.cell,
        volume: fixture.required_counts.volume,
      }
    );

    const recall = await invoke(CLAUDE_TOKEN, "tools/call", {
      name: "ask_memory",
      arguments: { query: "paired acceptance seed" },
    });
    assert.match(JSON.stringify(recall), /Paired acceptance seed/);
    const citation = await invoke(CLAUDE_TOKEN, "tools/call", {
      name: "read_memory",
      arguments: { path: "Knowledge Base/Seeds/paired-acceptance.md" },
    });
    assert.match(JSON.stringify(citation), /Knowledge Base\/Seeds\/paired-acceptance.md/);
    await invoke(CLAUDE_TOKEN, "tools/call", {
      name: "remember",
      arguments: { title: "Local paired capture", content: "A durable local paired capture." },
    });
    const freshChatRecall = await invoke(OPENAI_TOKEN, "tools/call", {
      name: "ask_memory",
      arguments: { query: "local paired capture" },
    });
    assert.match(JSON.stringify(freshChatRecall), /A durable local paired capture/);
    assert.equal(new Set(attachments.map((attached) => attached.userId)).size, 1);
    assert.equal(new Set(attachments.map((attached) => attached.tenantId)).size, 1);
    assert.equal(new Set(attachments.map((attached) => attached.familyId)).size, 2);
    assert.equal(store.tenants.get(TENANT)?.boundCellId, cellId);
    assert.equal(provider.resources.size, 1);

    await store.enqueue(TENANT, "suspend", "paired-acceptance-suspend", cellId);
    await converge(reconciler);
    const suspended = await invoke(CLAUDE_TOKEN, "tools/call", {
      name: "ask_memory",
      arguments: { query: "paired acceptance seed" },
    });
    assert.match(JSON.stringify(suspended), /EXOMEM_SUSPENDED/);
    await store.enqueue(TENANT, "resume", "paired-acceptance-resume", cellId);
    await converge(reconciler);
    await invoke(CLAUDE_TOKEN, "tools/call", {
      name: "ask_memory",
      arguments: { query: "paired acceptance seed" },
    });
    await invoke(REVOKED_TOKEN, "tools/list");
    assert.equal(store.tenants.get(TENANT)?.boundCellId, cellId);
    assert.equal(provider.resources.size, 1);

    await store.enqueue(TENANT, "delete", "paired-acceptance-delete", cellId);
    await converge(reconciler);
    assert.equal(store.statusForTenant(TENANT).state, "deleted");
    assert.equal(store.tenants.get(TENANT)?.boundCellId, null);
    assert.equal(provider.resources.size, 0);
  });
});
