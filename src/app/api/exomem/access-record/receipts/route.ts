import { receiveAccessNotification } from "@/lib/exomem-hosted/cloud-access-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  return receiveAccessNotification(request);
}
