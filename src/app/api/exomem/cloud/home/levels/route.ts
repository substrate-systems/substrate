import { handleCloudHomeLevelsRequest } from "@/lib/exomem-hosted/cloud-home-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleCloudHomeLevelsRequest(request);
}

export async function PUT(request: Request): Promise<Response> {
  return handleCloudHomeLevelsRequest(request);
}
