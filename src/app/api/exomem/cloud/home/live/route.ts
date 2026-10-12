import { handleCloudHomeLiveRequest } from "@/lib/exomem-hosted/cloud-home-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleCloudHomeLiveRequest(request);
}
