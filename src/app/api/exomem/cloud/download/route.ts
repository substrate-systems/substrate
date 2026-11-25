import { handleCloudMediaDownloadRequest } from "@/lib/exomem-hosted/cloud-media-download";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleCloudMediaDownloadRequest(request);
}
