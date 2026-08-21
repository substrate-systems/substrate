import { withExomemTransaction, type ExomemSql } from "./db";

const PROFILE = "hosted-alpha-agent-v1";
const MAX_AUTHORITY_ROWS = 4096;

export type HostedRuntimeIdentity = {
  releaseVersion: string;
  protocolVersion: string;
  agentProfile: typeof PROFILE;
  gatewayContractDigest: string;
  commandFingerprint: string;
  schemaDigest: string;
  compatibilityDigest: string;
};

export type ExomemHostedFleetObservation = {
  artifact: "exomem-hosted-substrate-fleet-observation";
  schemaVersion: 1;
  observedAt: string;
  routableCells: Array<{ cellId: string; runtime: HostedRuntimeIdentity }>;
  tenantBindings: Array<{ cellId: string; status: "active" | "destroyed" }>;
  assignments: Array<{
    assignmentId: string;
    cellId: string;
    status: string;
    targetRuntime: HostedRuntimeIdentity;
  }>;
  unfinishedOperations: Array<{
    operationId: string;
    cellId: string;
    kind: string;
    status: string;
    targetRuntime: HostedRuntimeIdentity;
  }>;
  capacityClaims: Array<{ cellId: string }>;
  capacityActiveCellCount: number;
  reviewerAuthorities: Array<{ cellId: string }>;
  reviewerTenants: Array<{ cellId: string }>;
};

type Row = Record<string, unknown>;

function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new Error("fleet observation row is invalid");
  }
  return value;
}

function runtime(row: Row): HostedRuntimeIdentity {
  const identity = {
    releaseVersion: text(row, "source_release"),
    protocolVersion: text(row, "protocol_version"),
    agentProfile: PROFILE,
    gatewayContractDigest: text(row, "gateway_contract_digest"),
    commandFingerprint: text(row, "command_fingerprint"),
    schemaDigest: text(row, "schema_digest"),
    compatibilityDigest: text(row, "compatibility_digest"),
  } as const;
  for (const digest of [
    identity.gatewayContractDigest,
    identity.commandFingerprint,
    identity.schemaDigest,
    identity.compatibilityDigest,
  ]) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("fleet observation row is invalid");
  }
  return identity;
}

function bounded(rows: Row[]): Row[] {
  if (rows.length > MAX_AUTHORITY_ROWS) throw new Error("fleet observation exceeds bound");
  return rows;
}

function observedAt(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) throw new Error("fleet observation timestamp is invalid");
  return date.toISOString().replace(/\.000Z$/, "Z");
}

async function snapshot(tx: ExomemSql): Promise<ExomemHostedFleetObservation> {
  await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
  const timestamp = await tx`
    /* exomem:fleet-observed-at */
    SELECT date_trunc('second', transaction_timestamp()) AS observed_at
  `;
  const routable = bounded(
    (
      await tx`
        /* exomem:fleet-routable-cells */
        SELECT observation.cell_id::text AS cell_id,
               observation.source_release,
               observation.protocol_version,
               cell.observed_gateway_contract_digest AS gateway_contract_digest,
               observation.command_fingerprint,
               observation.contract_digest AS schema_digest,
               observation.compatibility_digest
        FROM exomem_routable_cell_contracts AS observation
        JOIN exomem_cells AS cell ON cell.id = observation.cell_id
        WHERE observation.profile_id = ${PROFILE}
          AND observation.routable
        ORDER BY observation.cell_id
        LIMIT 4097
      `
    ).rows
  );
  const bindings = bounded(
    (
      await tx`
        /* exomem:fleet-tenant-bindings */
        SELECT binding.cell_id, binding.status
        FROM (
          SELECT tenant.bound_cell_id::text AS cell_id, 'active'::text AS status
          FROM exomem_tenants AS tenant
          WHERE tenant.bound_cell_id IS NOT NULL
            AND tenant.status <> 'deleted'
          UNION ALL
          SELECT cell.id::text AS cell_id, 'destroyed'::text AS status
          FROM exomem_cells AS cell
          WHERE cell.lifecycle_state = 'deleted'
        ) AS binding
        ORDER BY binding.cell_id, binding.status
        LIMIT 4097
      `
    ).rows
  );
  const assignments = bounded(
    (
      await tx`
        /* exomem:fleet-assignments */
        SELECT assignment.id::text AS assignment_id,
               tenant.bound_cell_id::text AS cell_id,
               assignment.state,
               assignment.source_release,
               assignment.protocol_version,
               assignment.gateway_contract_digest,
               assignment.command_fingerprint,
               assignment.schema_digest,
               assignment.compatibility_digest
        FROM exomem_agent_contract_rollout_assignments AS assignment
        JOIN exomem_tenants AS tenant ON tenant.id = assignment.tenant_id
        WHERE assignment.state IN ('preparing', 'active')
          AND tenant.bound_cell_id IS NOT NULL
        ORDER BY assignment.id
        LIMIT 4097
      `
    ).rows
  );
  const operations = bounded(
    (
      await tx`
        /* exomem:fleet-unfinished-operations */
        SELECT operation.id::text AS operation_id,
               COALESCE(
                 operation.cell_id::text,
                 'unassigned-' || operation.id::text
               ) AS cell_id,
               operation.operation_type,
               operation.state,
               operation.target_source_release AS source_release,
               operation.target_protocol_version AS protocol_version,
               operation.target_gateway_contract_digest AS gateway_contract_digest,
               operation.target_command_fingerprint AS command_fingerprint,
               operation.target_schema_digest AS schema_digest,
               operation.target_compatibility_digest AS compatibility_digest
        FROM exomem_lifecycle_operations AS operation
        WHERE operation.state NOT IN ('succeeded', 'failed_terminal')
        ORDER BY operation.id
        LIMIT 4097
      `
    ).rows
  );
  const capacityClaims = bounded(
    (
      await tx`
        /* exomem:fleet-capacity-claims */
        SELECT COALESCE(
                 tenant.bound_cell_id::text,
                 'unassigned-' || allocation.id::text
               ) AS cell_id
        FROM exomem_capacity_allocations AS allocation
        JOIN exomem_tenants AS tenant ON tenant.id = allocation.tenant_id
        WHERE allocation.state <> 'released'
        ORDER BY allocation.id
        LIMIT 4097
      `
    ).rows
  );
  const capacityCount = await tx`
    /* exomem:fleet-capacity-active-count */
    SELECT count(*)::integer AS active_cell_count
    FROM exomem_capacity_allocations AS allocation
    WHERE allocation.state IN ('reserved', 'occupied', 'uncertain')
      AND allocation.runtime_slots > 0
  `;
  const reviewerAuthorities = bounded(
    (
      await tx`
        /* exomem:fleet-reviewer-authorities */
        SELECT DISTINCT tenant.bound_cell_id::text AS cell_id
        FROM exomem_marketplace_reviewer_credentials AS credential
        JOIN exomem_tenants AS tenant ON tenant.id = credential.tenant_id
        WHERE credential.revoked_at IS NULL
          AND credential.expires_at > now()
          AND tenant.bound_cell_id IS NOT NULL
        ORDER BY tenant.bound_cell_id::text
        LIMIT 4097
      `
    ).rows
  );
  const reviewerTenants = bounded(
    (
      await tx`
        /* exomem:fleet-reviewer-tenants */
        SELECT tenant.bound_cell_id::text AS cell_id
        FROM exomem_tenants AS tenant
        WHERE tenant.marketplace_reviewer_purpose
          AND tenant.status <> 'deleted'
          AND tenant.bound_cell_id IS NOT NULL
        ORDER BY tenant.bound_cell_id
        LIMIT 4097
      `
    ).rows
  );

  const timestampRow = timestamp.rows[0];
  const count = Number(capacityCount.rows[0]?.active_cell_count ?? 0);
  if (!timestampRow || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("fleet observation row is invalid");
  }
  return {
    artifact: "exomem-hosted-substrate-fleet-observation",
    schemaVersion: 1,
    observedAt: observedAt(timestampRow.observed_at),
    routableCells: routable.map((row) => ({ cellId: text(row, "cell_id"), runtime: runtime(row) })),
    tenantBindings: bindings.map((row) => {
      const status = text(row, "status");
      if (status !== "active" && status !== "destroyed") {
        throw new Error("fleet observation row is invalid");
      }
      return { cellId: text(row, "cell_id"), status };
    }),
    assignments: assignments.map((row) => ({
      assignmentId: text(row, "assignment_id"),
      cellId: text(row, "cell_id"),
      status: text(row, "state"),
      targetRuntime: runtime(row),
    })),
    unfinishedOperations: operations.map((row) => ({
      operationId: text(row, "operation_id"),
      cellId: text(row, "cell_id"),
      kind: text(row, "operation_type"),
      status: text(row, "state"),
      targetRuntime: runtime(row),
    })),
    capacityClaims: capacityClaims.map((row) => ({ cellId: text(row, "cell_id") })),
    capacityActiveCellCount: count,
    reviewerAuthorities: reviewerAuthorities.map((row) => ({ cellId: text(row, "cell_id") })),
    reviewerTenants: reviewerTenants.map((row) => ({ cellId: text(row, "cell_id") })),
  };
}

export async function getExomemHostedFleetObservation(): Promise<ExomemHostedFleetObservation> {
  return withExomemTransaction(snapshot);
}
