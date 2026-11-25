import { handleCloudHomeWhatsNewRequest } from "@/lib/exomem-hosted/cloud-home-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleCloudHomeWhatsNewRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleCloudHomeWhatsNewRequest(request);
}
