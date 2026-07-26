import { executeExomemSql } from "./db";
import { createHmac, timingSafeEqual } from "node:crypto";

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

export type TrustedInstallTarget = { origin: string; path: string };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function parseClientArtifact(input: unknown, trustedTarget: TrustedInstallTarget): ClientArtifact {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("client artifact must be an object");
  const raw = input as Record<string, unknown>;
  if (raw.platform !== "claude" && raw.platform !== "openai") throw new Error("unsupported artifact platform");
  if (raw.state !== "pending") throw new Error("candidate artifacts must import as pending");
  const installUrl = new URL(String(raw.installUrl));
  if (installUrl.username || installUrl.password || installUrl.origin !== trustedTarget.origin || installUrl.pathname !== trustedTarget.path ||
      installUrl.protocol !== "https:" || installUrl.search || installUrl.hash || /(?:token|tenant|cell|secret|localhost)/i.test(installUrl.toString())) {
    throw new Error("install URL must be tenant-neutral HTTPS without credentials");
  }
  const observedAt = new Date(String(raw.observedAt));
  if (Number.isNaN(observedAt.valueOf()) || observedAt.valueOf() > Date.now() + 5 * 60_000 || observedAt.valueOf() < Date.now() - 24 * 60 * 60_000) throw new Error("observedAt is outside the evidence window");
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

export async function promoteClientArtifact(input: {
  artifactId: string;
  platform: "claude" | "openai";
  evidenceSha256: string;
  resultSha256: string;
  operatorKeyId: string;
  signature: string;
  trustedKeyId: string;
  trustedSecret: string;
}): Promise<boolean> {
  if (!input.trustedSecret || input.operatorKeyId !== input.trustedKeyId || !/^[a-f0-9]{64}$/.test(input.signature)) {
    throw new Error("artifact promotion requires trusted signed evidence");
  }
  const signed = canonical({ artifactId: input.artifactId, platform: input.platform, evidenceSha256: input.evidenceSha256, resultSha256: input.resultSha256, operatorKeyId: input.operatorKeyId });
  const expectedSignature = createHmac("sha256", input.trustedSecret).update(signed).digest();
  const suppliedSignature = Buffer.from(input.signature, "hex");
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
    throw new Error("artifact evidence signature is invalid");
  }
  const { rows } = await executeExomemSql`
    /* exomem:promote-client-artifact */
    WITH candidate AS (
      SELECT * FROM exomem_client_artifacts
      WHERE id = ${input.artifactId}::uuid AND platform = ${input.platform} AND state = 'pending'
      FOR UPDATE
    ), evidence AS (
      SELECT 1 FROM candidate
      WHERE evidence_sha256 = ${sha256(input.evidenceSha256, "evidence digest")}
        AND result_sha256 = ${sha256(input.resultSha256, "result digest")}
        AND observed_at <= now() AND observed_at > now() - interval '24 hours'
    ), retired AS (
      UPDATE exomem_client_artifacts SET state = 'retired', retired_at = now()
      WHERE platform = ${input.platform} AND state = 'live' AND EXISTS (SELECT 1 FROM evidence)
      RETURNING id
    ), serial AS (SELECT count(*) FROM retired), promoted AS (
      UPDATE exomem_client_artifacts SET state = 'live', promoted_at = now()
      FROM serial WHERE id = ${input.artifactId}::uuid AND EXISTS (SELECT 1 FROM evidence)
      RETURNING id
    ) SELECT id FROM promoted
  `;
  return rows.length === 1;
}

export async function demoteClientArtifact(artifactId: string, reasonSha256: string): Promise<boolean> {
  const { rows } = await executeExomemSql`
    /* exomem:demote-client-artifact */
    UPDATE exomem_client_artifacts SET state = 'failed', retired_at = now()
    WHERE id = ${artifactId}::uuid AND state = 'live' AND ${sha256(reasonSha256, "demotion reason")} IS NOT NULL
    RETURNING id
  `;
  return rows.length === 1;
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
