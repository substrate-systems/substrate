import { executeExomemSql } from "./db";

export type OwnerInstallAction = {
  platform: "claude" | "openai";
  version: string;
  installUrl: string;
};

function publicInstallAction(row: Record<string, unknown>): OwnerInstallAction | null {
  if (
    row.state !== "live" ||
    (row.platform !== "claude" && row.platform !== "openai") ||
    typeof row.plugin_version !== "string" ||
    !row.plugin_version
  ) {
    return null;
  }
  try {
    const installUrl = new URL(String(row.install_url));
    if (
      installUrl.protocol !== "https:" ||
      installUrl.username ||
      installUrl.password ||
      installUrl.search ||
      installUrl.hash ||
      /(?:bearer|cell|mcp|secret|tenant|token)/i.test(installUrl.toString())
    ) {
      return null;
    }
    return {
      platform: row.platform,
      version: row.plugin_version,
      installUrl: installUrl.href,
    };
  } catch {
    return null;
  }
}

/** Reads only server-owned native install actions after owner entitlement gating. */
export async function loadOwnerInstallActions(
  userId: string,
  tenantId: string
): Promise<OwnerInstallAction[]> {
  const { rows } = await executeExomemSql`
    /* exomem:owner-install-actions */
    SELECT artifact.platform, artifact.state, artifact.plugin_version, artifact.install_url
    FROM (SELECT DISTINCT candidate_id AS id FROM exomem_hosted_alpha_platform_cohort) AS cohort
    JOIN exomem_agent_contract_candidates AS candidate ON candidate.id = cohort.id
    JOIN exomem_client_artifacts AS artifact ON artifact.platform IN ('claude', 'openai')
      AND artifact.state = 'live'
      AND artifact.contract_sha256 = candidate.schema_digest
      AND artifact.compatibility_sha256 = candidate.compatibility_digest
      AND artifact.package_sha256 = CASE artifact.platform
        WHEN 'claude' THEN candidate.claude_package_lock->>'artifact_sha256'
        WHEN 'openai' THEN candidate.openai_package_lock->>'artifact_sha256'
      END
      AND artifact.archive_sha256 = CASE artifact.platform
        WHEN 'claude' THEN candidate.claude_archive_lock->>'archive_sha256'
        WHEN 'openai' THEN candidate.openai_archive_lock->>'archive_sha256'
      END
      AND artifact.plugin_version = CASE artifact.platform
        WHEN 'claude' THEN candidate.claude_package_lock->>'plugin_version'
        WHEN 'openai' THEN candidate.openai_package_lock->>'plugin_version'
      END
      AND candidate.endpoint = CASE artifact.platform
        WHEN 'claude' THEN candidate.claude_package_lock->>'endpoint'
        WHEN 'openai' THEN candidate.openai_package_lock->>'endpoint'
      END
      AND (
        artifact.contract_candidate_id = candidate.id
        OR (artifact.platform = 'claude' AND artifact.contract_candidate_id IS NULL)
      )
    WHERE EXISTS (
        SELECT 1
        FROM exomem_tenants AS tenant
        JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = tenant.id
        WHERE tenant.owner_user_id = ${userId}::uuid
          AND tenant.id = ${tenantId}::uuid
          AND tenant.status IN ('provisioning', 'active')
          AND tenant.desired_state = 'running'
          AND entitlement.effective_state IN ('provisioning', 'active', 'grace')
      )
    ORDER BY artifact.platform
  `;
  const actions = rows.flatMap((row) => {
    const action = publicInstallAction(row as Record<string, unknown>);
    return action ? [action] : [];
  });
  return actions.length === 2 && new Set(actions.map((action) => action.platform)).size === 2
    ? actions
    : [];
}
