/**
 * Shared configuration surface for Exomem Cloud (design `adopt-exomem-cloud-plain-cells`).
 * This module has no side effects; nothing here runs at import time.
 */

import { createPrivateKey, type KeyObject } from "node:crypto";
import { loggedOccurrence } from "./logged-occurrence";

export type EnvironmentSource = Record<string, string | undefined>;

/** Design D4's cancelled-tenant export window, `EXOMEM_CLOUD_CANCELLED_RETENTION_DAYS`. */
export const DEFAULT_CLOUD_CANCELLED_RETENTION_DAYS = 30;

/** Design D1's unpaid-invite expiry: fixed at 7 days, not independently configured. */
export const CLOUD_AWAITING_CHECKOUT_EXPIRY_DAYS = 7;

/**
 * Paddle time for one sweep lane of the reconcile cron: the unpaid-hold
 * expiry, or the lapsed-checkout settlement. Those lanes run side by side,
 * and the account deletion finish after them takes up to 8 seconds, all
 * inside the scheduler's 20-second request timeout
 * (`totalTimeoutSeconds` in ops/exomem-hosted-schedules.json).
 */
export const CLOUD_SWEEP_PADDLE_BUDGET_MS = 5_000;

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
    /**
     * Signs the origin proof of every request the gateway forwards, whatever features are on
     * (contain-cloud-controller-compromise D1). Having it never turns a feature on: artifact
     * transport and uploads each need their own switch and their own cell selection below.
     */
    artifactSigningKey?: KeyObject;
    artifactCells?: ReadonlySet<string>;
    artifactAllCells?: boolean;
    /**
     * Cells whose agents receive Cloud upload handoffs (bridge-cloud-agent-uploads).
     * Absent leaves uploads off; enabling artifact transport alone never selects a cell.
     */
    uploadCells?: ReadonlySet<string>;
    /** The gateway answers the Cloud transfer tools itself; off sends every call to the cell. */
    transferToolsEnabled?: boolean;
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
 * needs this.
 */
export function loadExomemCloudResource(env: EnvironmentSource = process.env): ExomemCloudResource {
  const missing: string[] = [];
  const mcpUrl = requiredValue(env, "EXOMEM_CLOUD_MCP_URL", missing);
  const mcpPath = requiredValue(env, "EXOMEM_CLOUD_MCP_PATH", missing);
  if (missing.length) throw new ExomemCloudConfigurationError(missing);
  return { mcpUrl, mcpPath };
}

/**
 * The Cloud MCP address for a page or status that shows it, or null when the deployment
 * lacks it. A display shows the gap instead of failing or guessing an address.
 */
export function exomemCloudMcpUrlOrNull(env: EnvironmentSource = process.env): string | null {
  try {
    return loadExomemCloudResource(env).mcpUrl;
  } catch (error) {
    if (error instanceof ExomemCloudConfigurationError) return null;
    throw error;
  }
}

const ARTIFACT_SIGNING_KEY_ENV = "EXOMEM_CLOUD_ARTIFACT_SIGNING_KEY";

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
  const transferToolsEnabled =
    env.EXOMEM_CLOUD_TRANSFER_TOOLS_ENABLED?.trim().toLowerCase() === "true";

  const transport = env.EXOMEM_CLOUD_ARTIFACT_TRANSPORT_ENABLED?.trim().toLowerCase();
  const transportEnabled = transport === "1" || transport === "true";
  // Exactly "true" turns uploads on, the same reading as the transfer-tools switch.
  const uploadsEnabled = env.EXOMEM_CLOUD_UPLOAD_ENABLED?.trim().toLowerCase() === "true";
  // Loaded whenever it is set, so the gateway can sign a proof for every cell, not only the cells
  // that a feature selects.
  const featureNeedsKey = transportEnabled || uploadsEnabled;
  const artifactSigningKey = loadArtifactSigningKey(env, featureNeedsKey);
  if (!featureNeedsKey) {
    return {
      mcpUrl,
      mcpPath,
      cellTokenKey,
      ...(artifactSigningKey ? { artifactSigningKey } : {}),
      transferToolsEnabled,
    };
  }
  const artifactCells = transportEnabled
    ? cellIdList(env, "EXOMEM_CLOUD_ARTIFACT_CELL_IDS")
    : undefined;
  const uploadCells = uploadsEnabled ? cellIdList(env, "EXOMEM_CLOUD_UPLOAD_CELL_IDS") : undefined;
  // The deployment emits exactly "true" to select every cell, or leaves the
  // variable unset. Any other value reads as off, which is the safe direction
  // for a switch that widens fetch authority. It must not throw: the gateway
  // loads this on every request, its readiness check never loads it, and a
  // throw would let a rollout pass and then fail every request.
  const allCells = transportEnabled && env.EXOMEM_CLOUD_ARTIFACT_ALL_CELLS === "true";
  // A feature that signs artifact grants or upload routes cannot run without the key.
  if (!artifactSigningKey) throw new ExomemCloudConfigurationError([ARTIFACT_SIGNING_KEY_ENV]);
  return {
    mcpUrl,
    mcpPath,
    cellTokenKey,
    artifactSigningKey,
    ...(artifactCells ? { artifactCells, artifactAllCells: allCells } : {}),
    ...(uploadCells ? { uploadCells } : {}),
    transferToolsEnabled,
  };
}

// Configuration loads on every request, before authentication, so any client can drive this count.
let unusableArtifactKeyLoads = 0;

/**
 * The gateway's request-signing key: one Ed25519 key for origin proofs, artifact grants and
 * upload routes, each with its own audience. Unset or blank is absent.
 *
 * A value that is set and is not an Ed25519 private key fails the configuration when a feature
 * needs the key. Otherwise it reads as unset and logs the variable name only, on the 1st, 2nd,
 * 4th, 8th... load: every cell then reports the request as unproven, whereas a throw here would
 * fail every /mcp request and OAuth discovery for every tenant, which costs far more than the
 * missing proof.
 */
function loadArtifactSigningKey(
  env: EnvironmentSource,
  featureNeedsKey: boolean
): KeyObject | undefined {
  const pem = env[ARTIFACT_SIGNING_KEY_ENV];
  if (!pem?.trim()) return undefined;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType === "ed25519") return key;
  } catch {
    // Key parser errors may echo supplied material; keep failures and logs value-free.
  }
  if (featureNeedsKey) throw new ExomemCloudConfigurationError([ARTIFACT_SIGNING_KEY_ENV]);
  unusableArtifactKeyLoads += 1;
  if (loggedOccurrence(unusableArtifactKeyLoads)) {
    console.warn({
      event: "exomem_cloud_artifact_signing_key_invalid",
      variable: ARTIFACT_SIGNING_KEY_ENV,
      count: unusableArtifactKeyLoads,
    });
  }
  return undefined;
}

/**
 * The key that signs export and import grants (contain-cloud-controller-compromise D4):
 * an Ed25519 private key in PEM form, apart from the gateway's request-signing key, so a
 * gateway compromise cannot authorize an export. Only the web app reads it.
 *
 * Absent, the control plane signs no grant and the cells log `grant_missing`. A value that
 * is not an Ed25519 private key is treated the same way and logged by name only: while the
 * cells report and do not refuse, a mistyped key must not stop an owner's export or import.
 */
const CLOUD_GRANT_SIGNING_KEY_ENV = "EXOMEM_CLOUD_GRANT_SIGNING_KEY";

export function loadCloudGrantSigningKey(
  env: EnvironmentSource = process.env
): KeyObject | undefined {
  return loadEd25519SigningKey(env, CLOUD_GRANT_SIGNING_KEY_ENV);
}

/**
 * The key that signs each cell's deletion grant (automate-cell-storage-deletion
 * D1): an Ed25519 private key in PEM form, apart from the operation grant key,
 * so the operator turns purges on independently of exports and imports. Only
 * the web app reads it; the executors hold only the matching public key.
 *
 * Absent, Substrate signs no grant and nothing purges. A value that is not an
 * Ed25519 private key is treated the same way and logged by name only: a
 * mistyped key must not stop a cell's deletion.
 */
const CLOUD_DELETION_GRANT_SIGNING_KEY_ENV = "EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY";

export function loadCloudDeletionGrantSigningKey(
  env: EnvironmentSource = process.env
): KeyObject | undefined {
  return loadEd25519SigningKey(env, CLOUD_DELETION_GRANT_SIGNING_KEY_ENV);
}

function loadEd25519SigningKey(
  env: EnvironmentSource,
  variable: string
): KeyObject | undefined {
  const pem = env[variable]?.trim();
  if (!pem) return undefined;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType === "ed25519") return key;
  } catch {
    // Key parser errors may echo supplied material; fall through to the value-free warning.
  }
  console.warn({ event: "exomem_cloud_grant_key_invalid", variable });
  return undefined;
}

/** A Cloud cell ID: 16 lowercase base32 characters. */
export const CLOUD_CELL_ID_PATTERN = /^[a-z2-7]{16}$/;

function cellIdList(env: EnvironmentSource, name: string): ReadonlySet<string> {
  let cells: unknown;
  try {
    cells = JSON.parse(env[name] ?? "");
  } catch {
    throw new ExomemCloudConfigurationError([name]);
  }
  if (
    !Array.isArray(cells) ||
    cells.length > 1024 ||
    cells.some((cell) => typeof cell !== "string" || !CLOUD_CELL_ID_PATTERN.test(cell))
  ) {
    throw new ExomemCloudConfigurationError([name]);
  }
  return new Set(cells as string[]);
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

/** The cell controller's default for `EXOMEM_EXPORT_TTL_HOURS`. */
const DEFAULT_EXPORT_TTL_HOURS = 24;

/**
 * How long a ready export stays at the object store, for the privacy page.
 * The cell controller enforces it with its own copy of the same setting, so
 * both deployments must set the same value. A malformed value fails loudly
 * rather than letting the policy state a time the controller does not use.
 */
export function loadExportTtlHours(env: EnvironmentSource = process.env): number {
  const raw = env.EXOMEM_EXPORT_TTL_HOURS?.trim();
  if (!raw) return DEFAULT_EXPORT_TTL_HOURS;
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours < 1) {
    throw new ExomemCloudConfigurationError(["EXOMEM_EXPORT_TTL_HOURS"]);
  }
  return hours;
}
