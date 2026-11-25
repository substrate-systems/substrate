import { handleCloudHomeFilingRequest } from "@/lib/exomem-hosted/cloud-home-mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ importId: string }> }
): Promise<Response> {
  const { importId } = await context.params;
  return handleCloudHomeFilingRequest(request, importId);
}

export async function POST(
  request: Request,
  context: { params: Promise<{ importId: string }> }
): Promise<Response> {
  const { importId } = await context.params;
  return handleCloudHomeFilingRequest(request, importId);
}
