import { handleAccessLogRequest } from "@/lib/exomem-hosted/cloud-access-log";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  return handleAccessLogRequest(request, "challenge");
}
