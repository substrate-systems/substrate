import { handleCloudViewerRequest } from "@/lib/exomem-hosted/cloud-viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = (request: Request) => handleCloudViewerRequest(request, "map");
