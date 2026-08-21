import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemTransactionForTests } from "../db";
import { getExomemHostedFleetObservation } from "../fleet-observation";

const CELL = "018f2d91-7c42-7000-8000-000000000081";
const ASSIGNMENT = "018f2d91-7c42-7000-8000-000000000082";
const OPERATION = "018f2d91-7c42-7000-8000-000000000083";

function runtimeRow() {
  return {
    cell_id: CELL,
    source_release: "0.57.2",
    protocol_version: "1",
    gateway_contract_digest: "a".repeat(64),
    command_fingerprint: "b".repeat(64),
    schema_digest: "c".repeat(64),
    compatibility_digest: "d".repeat(64),
  };
}

afterEach(() => __setExomemTransactionForTests(null));

describe("Exomem hosted fleet observation", () => {
  it("returns one coherent bounded authority snapshot without identity or content", async () => {
    const queries: string[] = [];
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("fleet-observed-at")) {
        return { rows: [{ observed_at: new Date("2026-08-21T12:34:56.000Z") }] };
      }
      if (query.includes("fleet-routable-cells")) return { rows: [runtimeRow()] };
      if (query.includes("fleet-tenant-bindings")) {
        return { rows: [{ cell_id: CELL, status: "active" }] };
      }
      if (query.includes("fleet-assignments")) {
        return {
          rows: [
            {
              ...runtimeRow(),
              assignment_id: ASSIGNMENT,
              state: "preparing",
            },
          ],
        };
      }
      if (query.includes("fleet-unfinished-operations")) {
        return {
          rows: [
            {
              ...runtimeRow(),
              operation_id: OPERATION,
              operation_type: "rollforward",
              state: "running",
            },
          ],
        };
      }
      if (query.includes("fleet-capacity-claims")) return { rows: [{ cell_id: CELL }] };
      if (query.includes("fleet-capacity-active-count")) {
        return { rows: [{ active_cell_count: 1 }] };
      }
      if (query.includes("fleet-reviewer-authorities")) return { rows: [] };
      if (query.includes("fleet-reviewer-tenants")) return { rows: [] };
      return { rows: [] };
    };
    __setExomemTransactionForTests(async (work) => work(sql));

    const observation = await getExomemHostedFleetObservation();

    assert.equal(queries[0]?.includes("REPEATABLE READ READ ONLY"), true);
    assert.deepEqual(observation, {
      artifact: "exomem-hosted-substrate-fleet-observation",
      schemaVersion: 1,
      observedAt: "2026-08-21T12:34:56Z",
      routableCells: [{ cellId: CELL, runtime: observation.routableCells[0]?.runtime }],
      tenantBindings: [{ cellId: CELL, status: "active" }],
      assignments: [
        {
          assignmentId: ASSIGNMENT,
          cellId: CELL,
          status: "preparing",
          targetRuntime: observation.routableCells[0]?.runtime,
        },
      ],
      unfinishedOperations: [
        {
          operationId: OPERATION,
          cellId: CELL,
          kind: "rollforward",
          status: "running",
          targetRuntime: observation.routableCells[0]?.runtime,
        },
      ],
      capacityClaims: [{ cellId: CELL }],
      capacityActiveCellCount: 1,
      reviewerAuthorities: [],
      reviewerTenants: [],
    });
    const serialized = JSON.stringify(observation).toLowerCase();
    for (const forbidden of ["owner", "email", "credential", "token", "vault", "title", "path"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.equal(
      queries
        .filter((query) =>
          /fleet-(?:routable|tenant|assignments|unfinished|capacity-claims|reviewer)/i.test(query)
        )
        .every((query) => /LIMIT 4097/i.test(query)),
      true
    );
  });

  it("refuses an authority set beyond the observation bound", async () => {
    const sql = async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("fleet-observed-at")) {
        return { rows: [{ observed_at: new Date("2026-08-21T12:34:56.000Z") }] };
      }
      if (query.includes("fleet-routable-cells")) {
        return { rows: Array.from({ length: 4097 }, runtimeRow) };
      }
      return { rows: [] };
    };
    __setExomemTransactionForTests(async (work) => work(sql));

    await assert.rejects(getExomemHostedFleetObservation(), /fleet observation exceeds bound/);
  });
});
