import { handleCloudExportsRequest } from "@/lib/exomem-hosted/cloud-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleCloudExportsRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCloudExportsRequest(request);
}
