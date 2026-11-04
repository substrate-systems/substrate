import { createHmac, timingSafeEqual } from "node:crypto";
import { withExomemTransaction } from "./db";

export type AccessReceipt = {
  bucketId: string;
  objectKey: string;
  versionId: string;
  providerAt: string;
};
export type AccessReceiptConfig = {
  enabled: boolean;
  bucketId: string;
  prefix: string;
  signingSecret: string;
};

function accessReceiptConfig(): AccessReceiptConfig {
  return {
    enabled: process.env.EXOMEM_CLOUD_ACCESS_LOG_ENABLED === "true",
    bucketId: process.env.EXOMEM_ACCESS_RECORD_BUCKET_ID ?? "",
    prefix: process.env.EXOMEM_ACCESS_RECORD_PREFIX ?? "access/",
    signingSecret: process.env.EXOMEM_ACCESS_RECORD_NOTIFICATION_SECRET ?? "",
  };
}

async function persistReceipts(receipts: AccessReceipt[]): Promise<void> {
  await withExomemTransaction(async (tx) => {
    for (const receipt of receipts) {
      await tx`
        INSERT INTO exomem_cloud_access_receipts (bucket_id, object_key, version_id, provider_at)
        VALUES (${receipt.bucketId}, ${receipt.objectKey}, ${receipt.versionId}, ${receipt.providerAt}::timestamptz)
        ON CONFLICT (bucket_id, object_key, version_id) DO NOTHING
      `;
    }
  });
}

export async function receiveAccessNotification(
  request: Request,
  config = accessReceiptConfig(),
  persist: (receipts: AccessReceipt[]) => Promise<void> = persistReceipts
): Promise<Response> {
  if (!config.enabled) return new Response(null, { status: 404 });
  if (!config.bucketId || !config.signingSecret) return new Response(null, { status: 503 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 128 * 1024) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(chunk.value);
    }
    const body = Buffer.concat(chunks);
    const expected = `v1=${createHmac("sha256", config.signingSecret).update(body).digest("hex")}`;
    const signature = request.headers.get("x-bz-event-notification-signature") ?? "";
    if (
      Buffer.byteLength(signature) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return new Response(null, { status: 401 });
    let payload;
    try {
      payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!payload || !Array.isArray(payload.events) || payload.events.length > 50)
      return new Response(null, { status: 400 });
    const receipts: AccessReceipt[] = [];
    for (const event of payload.events) {
      if (!event || typeof event !== "object" || Array.isArray(event))
        return new Response(null, { status: 400 });
      // B2 fixes these protocol tokens. Other signed events do not identify an uploaded version.
      if (event.eventType === "b2:TestEvent") continue;
      if (
        event.eventVersion !== 1 ||
        !["b2:ObjectCreated:Upload", "b2:ObjectCreated:MultipartUpload"].includes(
          event.eventType
        ) ||
        event.bucketId !== config.bucketId ||
        typeof event.objectName !== "string" ||
        !event.objectName.startsWith(config.prefix) ||
        event.objectName.length > 1024 ||
        typeof event.objectVersionId !== "string" ||
        !event.objectVersionId ||
        event.objectVersionId.length > 1024 ||
        !Number.isSafeInteger(event.eventTimestamp) ||
        !Number.isFinite(new Date(event.eventTimestamp).getTime())
      )
        return new Response(null, { status: 400 });
      receipts.push({
        bucketId: event.bucketId,
        objectKey: event.objectName,
        versionId: event.objectVersionId,
        providerAt: new Date(event.eventTimestamp).toISOString(),
      });
    }
    await persist(receipts);
    return new Response(null, { status: 200 });
  } catch (error) {
    return new Response(null, { status: error instanceof SyntaxError ? 400 : 503 });
  }
}
