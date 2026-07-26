import { executeExomemSql } from "./db";

export type ClientArtifactState = "pending" | "live" | "failed" | "retired";
export type ClientArtifact = {
  platform: "claude" | "openai";
  state: ClientArtifactState;
  packageSha256: string;
  archiveSha256: string;
  compatibilitySha256: string;
  contractSha256: string;
  pluginVersion: string;
  clientIdentity: string;
  installUrl: string;
  evidenceSha256: string;
  resultSha256: string;
  observedAt: string;
};

const sha256 = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
};

const ALLOWED_INSTALL_TARGETS = {
  claude: { origin: "https://claude.ai", path: "/plugins/exomem-hosted" },
  openai: { origin: "https://chatgpt.com", path: "/apps/exomem-hosted" },
} as const;

export function parseClientArtifact(input: unknown): ClientArtifact {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("client artifact must be an object");
  const raw = input as Record<string, unknown>;
  if (raw.platform !== "claude" && raw.platform !== "openai") throw new Error("unsupported artifact platform");
  if (!(["pending", "live", "failed", "retired"] as string[]).includes(String(raw.state))) throw new Error("unsupported artifact state");
  const installUrl = new URL(String(raw.installUrl));
  const allowed = ALLOWED_INSTALL_TARGETS[raw.platform];
  if (installUrl.username || installUrl.password || installUrl.origin !== allowed.origin || installUrl.pathname !== allowed.path ||
      installUrl.protocol !== "https:" || installUrl.search || installUrl.hash || /(?:token|tenant|cell|secret|localhost)/i.test(installUrl.toString())) {
    throw new Error("install URL must be tenant-neutral HTTPS without credentials");
  }
  const observedAt = new Date(String(raw.observedAt));
  if (Number.isNaN(observedAt.valueOf())) throw new Error("observedAt must be a timestamp");
  for (const key of ["pluginVersion", "clientIdentity"]) if (typeof raw[key] !== "string" || !raw[key]) throw new Error(`${key} must be non-empty`);
  return {
    platform: raw.platform, state: raw.state as ClientArtifactState,
    packageSha256: sha256(raw.packageSha256, "package digest"), archiveSha256: sha256(raw.archiveSha256, "archive digest"),
    compatibilitySha256: sha256(raw.compatibilitySha256, "compatibility digest"), contractSha256: sha256(raw.contractSha256, "contract digest"),
    pluginVersion: raw.pluginVersion as string, clientIdentity: raw.clientIdentity as string,
    installUrl: installUrl.toString(), evidenceSha256: sha256(raw.evidenceSha256, "evidence digest"),
    resultSha256: sha256(raw.resultSha256, "result digest"), observedAt: observedAt.toISOString(),
  };
}

export async function storeClientArtifact(artifact: ClientArtifact): Promise<string> {
  const { rows } = await executeExomemSql`
    /* exomem:store-client-artifact */
    INSERT INTO exomem_client_artifacts (
      platform, state, package_sha256, archive_sha256, compatibility_sha256, contract_sha256,
      plugin_version, client_identity, install_url, evidence_sha256, result_sha256, observed_at
    ) VALUES (
      ${artifact.platform}, ${artifact.state}, ${artifact.packageSha256}, ${artifact.archiveSha256},
      ${artifact.compatibilitySha256}, ${artifact.contractSha256}, ${artifact.pluginVersion},
      ${artifact.clientIdentity}, ${artifact.installUrl}, ${artifact.evidenceSha256}, ${artifact.resultSha256}, ${artifact.observedAt}
    ) RETURNING id
  `;
  const id = rows[0]?.id;
  if (typeof id !== "string") throw new Error("client artifact insert returned no id");
  return id;
}
