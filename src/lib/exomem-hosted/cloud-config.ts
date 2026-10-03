/**
 * Shared configuration surface for Exomem Cloud (design `adopt-exomem-cloud-plain-cells`).
 *
 * Everything Cloud sits behind `EXOMEM_CLOUD_ENABLED`. With the flag off,
 * every Cloud-specific code path this module's callers gate on is simply
 * never reached, so hosted behaviour is unchanged — this module itself has
 * no side effects and touches no existing hosted table or function.
 */

import { createPrivateKey, type KeyObject } from "node:crypto";

export type EnvironmentSource = Record<string, string | undefined>;

/** Design D4's cancelled-tenant export window, `EXOMEM_CLOUD_CANCELLED_RETENTION_DAYS`. */
export const DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS = 30;

/** Design D1's unpaid-invite expiry: fixed at 7 days, not independently configured. */
export const CLOUD_AWAITING_CHECKOUT_EXPIRY_DAYS = 7;

export function exomemCloudEnabled(env: EnvironmentSource = process.env): boolean {
  const value = env.EXOMEM_CLOUD_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

export class ExomemCloudConfigurationError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`Exomem Cloud configuration is incomplete: ${missing.join(", ")}`);
    this.name = "ExomemCloudConfigurationError";
  }
}

export type ExomemCloudResource = Readonly<{
  mcpUrl: string;
  mcpPath: string;
}>;

export type ExomemCloudConfig = ExomemCloudResource &
  Readonly<{
    cellTokenKey: Buffer;
    artifactSigningKey?: KeyObject;
    artifactCells?: ReadonlySet<string>;
  }>;

function requiredValue(env: EnvironmentSource, name: string, missing: string[]): string {
  const value = env[name]?.trim();
  if (!value) missing.push(name);
  return value ?? "";
}

// Exactly 64 lowercase-or-uppercase hex characters -- a raw 32-byte key,
// nothing shorter or padded (security review finding 15). A key that merely
// decoded to >=32 bytes used to pass; a stray trailing byte or a
// copy-pasted 128-char key from the wrong system now fails config load
// instead of silently deriving cell tokens from an unintended-length key.
const CELL_TOKEN_KEY_HEX = /^[0-9a-f]{64}$/i;

/**
 * Loads the Cloud resource URL and the gateway's mount path, without the
 * cell-bearer key. The OAuth and status routes run on Vercel and need only
 * the resource; C4 gives `cell_token_key` to the gateway and cellctl alone,
 * so the web app never has to hold it. Throws only when a caller actually
 * needs this -- an unconfigured Cloud deployment must not fail anything on
 * the hosted path, so nothing here runs at import time.
 */
export function loadExomemCloudResource(env: EnvironmentSource = process.env): ExomemCloudResource {
  const missing: string[] = [];
  const mcpUrl = requiredValue(env, "EXOMEM_CLOUD_MCP_URL", missing);
  const mcpPath = requiredValue(env, "EXOMEM_CLOUD_MCP_PATH", missing);
  if (missing.length) throw new ExomemCloudConfigurationError(missing);
  return { mcpUrl, mcpPath };
}

/**
 * Loads the Cloud resource plus the cell-bearer derivation key (C4), for the
 * gateway, which derives each cell's bearer.
 *
 * The cancelled-tenant retention window is `DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS`,
 * a fixed constant (security review finding 9d) -- no `EXOMEM_CLOUD_CANCELLED_RETENTION_DAYS`
 * env override exists, so every deployment computes the same 30-day export window.
 */
export function loadExomemCloudConfig(env: EnvironmentSource = process.env): ExomemCloudConfig {
  const missing: string[] = [];
  const mcpUrl = requiredValue(env, "EXOMEM_CLOUD_MCP_URL", missing);
  const mcpPath = requiredValue(env, "EXOMEM_CLOUD_MCP_PATH", missing);
  const rawKey = requiredValue(env, "EXOMEM_CLOUD_CELL_TOKEN_KEY", missing);
  if (missing.length) throw new ExomemCloudConfigurationError(missing);

  if (!CELL_TOKEN_KEY_HEX.test(rawKey)) {
    throw new ExomemCloudConfigurationError(["EXOMEM_CLOUD_CELL_TOKEN_KEY"]);
  }
  const cellTokenKey = Buffer.from(rawKey, "hex");

  const transport = env.EXOMEM_CLOUD_ARTIFACT_TRANSPORT_ENABLED?.trim().toLowerCase();
  if (transport !== "1" && transport !== "true") return { mcpUrl, mcpPath, cellTokenKey };
  let cells: unknown;
  try {
    cells = JSON.parse(env.EXOMEM_CLOUD_ARTIFACT_CELL_IDS ?? "");
  } catch {
    throw new ExomemCloudConfigurationError(["EXOMEM_CLOUD_ARTIFACT_CELL_IDS"]);
  }
  if (
    !Array.isArray(cells) ||
    cells.length > 1024 ||
    cells.some((cell) => typeof cell !== "string" || !/^[a-z2-7]{16}$/.test(cell))
  ) {
    throw new ExomemCloudConfigurationError(["EXOMEM_CLOUD_ARTIFACT_CELL_IDS"]);
  }
  try {
    const artifactSigningKey = createPrivateKey(env.EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY ?? "");
    if (artifactSigningKey.asymmetricKeyType !== "ed25519") throw new Error();
    return {
      mcpUrl,
      mcpPath,
      cellTokenKey,
      artifactSigningKey,
      artifactCells: new Set(cells as string[]),
    };
  } catch {
    // Key parser errors may echo supplied material; keep startup failures value-free.
    throw new ExomemCloudConfigurationError(["EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY"]);
  }
}

/**
 * The cell image repository D5's release control (cloud-release.ts)
 * validates against (security review finding 10): `cell_image` and a cell's
 * `desired_image` override must be exactly `<this repository>@sha256:<64
 * lowercase hex>`, never a mutable tag -- a tag can be repointed after the
 * fact, so pinning to one would let the image a cell actually runs drift
 * silently out from under an operator's own release record. Its own env var,
 * not a field on `ExomemCloudConfig`: only the release module needs it, and
 * folding it into the shared config would force every one of that type's
 * many other callers (the gateway, OAuth routes, status) to carry a value
 * that has nothing to do with them.
 */
export function loadCloudCellImageRepository(env: EnvironmentSource = process.env): string {
  const repository = env.EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY?.trim();
  if (!repository) {
    throw new ExomemCloudConfigurationError(["EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY"]);
  }
  return repository;
}
