import { handleCloudExportLinkRequest } from "@/lib/exomem-hosted/cloud-exports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ exportId: string }> }
): Promise<Response> {
  const { exportId } = await context.params;
  return handleCloudExportLinkRequest(request, exportId);
}
