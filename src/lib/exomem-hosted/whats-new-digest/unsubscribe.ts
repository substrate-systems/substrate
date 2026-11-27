/**
 * The unsubscribe token of the monthly digest (`send-monthly-whats-new-digest`,
 * D5): signed, for one purpose, naming one tenant. It has no expiry, because
 * an unsubscribe link in an old email must keep working, and all it can do is
 * turn the setting off, which the owner may always do.
 *
 * The MAC is HMAC-SHA-256 under a key of its own (`EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY`,
 * 32 random bytes as unpadded base64url), under a label of its own, in the
 * shape of `cloud-download-ticket.ts`. No other key or label of this
 * application can produce a valid token, and this key signs nothing else.
 *
 * Rotation follows the runbook's other keys: the new key is
 * `EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY` and the old one `..._PREVIOUS`. Links in
 * emails already sent carry the old key's MAC, so both verify during the
 * overlap, and only the new key signs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { whatsNewDigestConfig } from "./config";
import { UNSUBSCRIBE_PAGE_PATH, UNSUBSCRIBE_POST_PATH } from "./unsubscribe-paths";

const PURPOSE = "whats-new-digest-unsubscribe";
const MAC_LABEL = "exomem-whats-new-digest-unsubscribe:v1\0";
const MAC_BYTES = 32;
const KEY_BYTES = 32;
// A token is about 150 characters; the bound only spares the MAC a hostile megabyte.
const MAX_TOKEN_CHARS = 512;

export { UNSUBSCRIBE_PAGE_PATH, UNSUBSCRIBE_POST_PATH };

export class UnsubscribeKeyError extends Error {
  constructor() {
    super("EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY must be 32 random bytes as unpadded base64url");
    this.name = "UnsubscribeKeyError";
  }
}

/** The signing key from configuration; throws `UnsubscribeKeyError` when it is unset or malformed. */
export function unsubscribeKey(encoded: string | null = whatsNewDigestConfig().unsubscribeKey) {
  // Format check on a key's encoding, not a reading of text.
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new UnsubscribeKeyError();
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== KEY_BYTES) throw new UnsubscribeKeyError();
  return key;
}

/**
 * The keys a token may verify under: the current key, and the previous one
 * while it is set. A key that is set but malformed throws, so a bad rotation
 * shows at once instead of dropping the links of the emails already sent.
 */
export function unsubscribeVerifyKeys(config = whatsNewDigestConfig()): Buffer[] {
  const keys = [unsubscribeKey(config.unsubscribeKey)];
  if (config.unsubscribeKeyPrevious !== null)
    keys.push(unsubscribeKey(config.unsubscribeKeyPrevious));
  return keys;
}

/** Whether a digest can be sent now: its unsubscribe link needs a valid key, and a valid previous one when set. */
export function unsubscribeKeyConfigured(): boolean {
  try {
    unsubscribeVerifyKeys();
    return true;
  } catch {
    return false;
  }
}

const claimsSchema = z.strictObject({
  v: z.literal(1),
  purpose: z.literal(PURPOSE),
  tenant_id: z.uuid(),
});

function mac(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(MAC_LABEL, "utf8").update(payload, "utf8").digest();
}

export function signUnsubscribeToken(tenantId: string, key: Buffer = unsubscribeKey()): string {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, purpose: PURPOSE, tenant_id: tenantId }),
    "utf8"
  ).toString("base64url");
  return `${payload}.${mac(payload, key).toString("base64url")}`;
}

/** The tenant id of a token that is genuine and for this purpose; otherwise null, with no hint of which check failed. */
export function verifyUnsubscribeToken(
  token: string,
  keys: Buffer | readonly Buffer[] = unsubscribeVerifyKeys()
): string | null {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, presented] = parts;
  const presentedMac = Buffer.from(presented, "base64url");
  if (presentedMac.length !== MAC_BYTES) return null;
  // Every key is tried; which one matched is of no use to a caller.
  const genuine = ([] as Buffer[])
    .concat(keys)
    .map((key) => timingSafeEqual(presentedMac, mac(payload, key)))
    .some(Boolean);
  if (!genuine) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const claims = claimsSchema.safeParse(decoded);
  return claims.success ? claims.data.tenant_id : null;
}

/**
 * The two addresses an email carries for one tenant: the POST target for the
 * `List-Unsubscribe` header, which a mail client calls with its one-click
 * POST, and the page link for the body, which shows a button that sends the
 * same POST. The page link keeps the token in the fragment, which a server
 * and a link scanner's request never see; the POST address needs it in the
 * query, because a mail client posts to the address as given.
 */
export function unsubscribeAddresses(
  publicBaseUrl: string,
  tenantId: string,
  key: Buffer = unsubscribeKey()
): { post: string; page: string } {
  const token = signUnsubscribeToken(tenantId, key);
  const post = new URL(UNSUBSCRIBE_POST_PATH, `${publicBaseUrl}/`);
  post.searchParams.set("token", token);
  const page = new URL(UNSUBSCRIBE_PAGE_PATH, `${publicBaseUrl}/`);
  page.hash = token;
  return { post: post.toString(), page: page.toString() };
}
