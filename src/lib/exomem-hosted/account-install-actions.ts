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
    FROM exomem_client_artifacts AS artifact
    WHERE artifact.platform IN ('claude', 'openai')
      AND artifact.state = 'live'
      AND EXISTS (
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
  return rows.flatMap((row) => {
    const action = publicInstallAction(row as Record<string, unknown>);
    return action ? [action] : [];
  });
}
