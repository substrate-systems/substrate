import { handleCloudImportRequest } from "@/lib/exomem-hosted/cloud-import-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleCloudImportRequest(request, "status");
}

export async function POST(request: Request): Promise<Response> {
  return handleCloudImportRequest(request, "create");
}
