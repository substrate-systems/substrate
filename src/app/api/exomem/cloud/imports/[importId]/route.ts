import { handleCloudImportRequest } from "@/lib/exomem-hosted/cloud-import-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ importId: string }> }
): Promise<Response> {
  const { importId } = await context.params;
  return handleCloudImportRequest(request, "status", importId);
}
