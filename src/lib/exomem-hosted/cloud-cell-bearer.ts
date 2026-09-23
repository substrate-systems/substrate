/**
 * Contract C4 (shared with Exomem, `adopt-exomem-cloud-plain-cells`):
 * `base64url_nopad(HMAC-SHA256(key, "exomem-cloud-cell-token-v1:" + cell_id))`.
 *
 * ASCII input, 43-character output. Node's `digest("base64url")` already
 * omits padding (unlike plain "base64"), so a 32-byte HMAC-SHA256 digest
 * base64url-encodes to exactly 43 characters with no further trimming
 * needed.
 */

import { createHmac } from "node:crypto";

const CELL_TOKEN_CONTEXT = "exomem-cloud-cell-token-v1:";

export function deriveCloudCellBearer(key: Buffer, cellId: string): string {
  return createHmac("sha256", key).update(`${CELL_TOKEN_CONTEXT}${cellId}`, "ascii").digest("base64url");
}
