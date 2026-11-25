/**
 * The download ticket (add-cloud-media-access D2): what the signed-in app hands a
 * browser so the gateway will serve one stored original of the owner's cell.
 *
 * It names a tenant, a cell, the owner's Home login (grant and token family)
 * and the exact path it was minted for. It carries no bearer: the gateway still
 * looks the login up on every request and refuses a revoked grant, a blocked
 * owner or a deleting account. A browser media element sends every Range
 * request to the address it first followed, so one ticket serves any number of
 * GETs of its path for its whole life, and no other path or route. That life is
 * long enough for a recording and a pause (four hours unless configured), so
 * the signer only names a login family that outlives it.
 *
 * The app and the gateway share `EXOMEM_CONTROL_PLANE_KEY`; the MAC below is
 * keyed with it under a label of its own, so no other use of that key (rate
 * limit keys, sealed envelopes) can produce a valid ticket.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { CLOUD_CELL_ID_PATTERN, type EnvironmentSource } from "./cloud-config";

const DOWNLOAD_TICKET_PURPOSE = "download";
const LIFETIME_SETTING = "EXOMEM_CLOUD_DOWNLOAD_TICKET_LIFETIME_SECONDS";
const DEFAULT_LIFETIME_SECONDS = 4 * 60 * 60;
// One minute to one day: below that a ticket is gone before the browser follows it, and a
// login family (thirty days) must outlive it.
const MIN_LIFETIME_SECONDS = 60;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
// A ticket is about 400 characters; the bound only spares the MAC a hostile megabyte.
const MAX_TICKET_CHARS = 1024;
const MAC_LABEL = "exomem-download-ticket:v1\0";
const MAC_BYTES = 32;

/**
 * How long a ticket lives, from `EXOMEM_CLOUD_DOWNLOAD_TICKET_LIFETIME_SECONDS`
 * (default four hours). The app signs with it and the gateway refuses a longer
 * one, so set it the same on both; a mismatch fails closed at the gateway. An
 * unusable value throws, because a ticket life nobody chose must not be guessed.
 */
export function downloadTicketLifetimeSeconds(env: EnvironmentSource = process.env): number {
  const raw = env[LIFETIME_SETTING]?.trim();
  if (!raw) return DEFAULT_LIFETIME_SECONDS;
  const seconds = Number(raw);
  if (!lifetimeInBounds(seconds)) {
    throw new RangeError(
      `${LIFETIME_SETTING} must be a whole number of seconds from ${MIN_LIFETIME_SECONDS} to ${MAX_LIFETIME_SECONDS}`
    );
  }
  return seconds;
}

function lifetimeInBounds(seconds: number): boolean {
  return (
    Number.isInteger(seconds) && seconds >= MIN_LIFETIME_SECONDS && seconds <= MAX_LIFETIME_SECONDS
  );
}

const claimsSchema = z.strictObject({
  v: z.literal(1),
  purpose: z.literal(DOWNLOAD_TICKET_PURPOSE),
  tenant_id: z.uuid(),
  cell_id: z.string().regex(CLOUD_CELL_ID_PATTERN),
  family_id: z.uuid(),
  grant_id: z.uuid(),
  path_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  iat: z.number().int(),
  exp: z.number().int(),
});

export type DownloadTicketClaims = {
  tenantId: string;
  cellId: string;
  familyId: string;
  grantId: string;
};

function pathDigest(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

function mac(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(MAC_LABEL, "utf8").update(payload, "utf8").digest();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function signDownloadTicket(
  input: DownloadTicketClaims & { path: string },
  key: Buffer,
  options: { now?: number; lifetimeSeconds?: number } = {}
): string {
  const now = options.now ?? nowSeconds();
  const lifetime = options.lifetimeSeconds ?? downloadTicketLifetimeSeconds();
  if (!lifetimeInBounds(lifetime)) {
    throw new RangeError("a download ticket lives from one minute to one day");
  }
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      purpose: DOWNLOAD_TICKET_PURPOSE,
      tenant_id: input.tenantId,
      cell_id: input.cellId,
      family_id: input.familyId,
      grant_id: input.grantId,
      path_sha256: pathDigest(input.path),
      iat: now,
      exp: now + lifetime,
    }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${mac(payload, key).toString("base64url")}`;
}

/**
 * The claims of a ticket that is genuine, unexpired and minted for exactly
 * `path`; otherwise null, with no hint of which check failed. A ticket is
 * only ever a pointer to a login: the caller must still resolve that login and
 * compare its tenant and cell with these claims.
 */
export function verifyDownloadTicket(
  ticket: string,
  path: string,
  key: Buffer,
  options: { now?: number; lifetimeSeconds?: number } = {}
): DownloadTicketClaims | null {
  const now = options.now ?? nowSeconds();
  const cap = options.lifetimeSeconds ?? downloadTicketLifetimeSeconds();
  if (ticket.length === 0 || ticket.length > MAX_TICKET_CHARS) return null;
  const parts = ticket.split(".");
  if (parts.length !== 2) return null;
  const [payload, presented] = parts;
  const presentedMac = Buffer.from(presented, "base64url");
  const expectedMac = mac(payload, key);
  if (presentedMac.length !== MAC_BYTES || !timingSafeEqual(presentedMac, expectedMac)) {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = claimsSchema.safeParse(decoded);
  if (!parsed.success) return null;
  const claims = parsed.data;
  if (
    claims.exp <= now ||
    claims.exp - claims.iat > cap ||
    claims.path_sha256 !== pathDigest(path)
  ) {
    return null;
  }
  return {
    tenantId: claims.tenant_id,
    cellId: claims.cell_id,
    familyId: claims.family_id,
    grantId: claims.grant_id,
  };
}
