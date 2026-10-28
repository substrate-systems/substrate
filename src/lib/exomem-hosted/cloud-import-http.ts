import { loadExomemCloudResource } from "./cloud-config";
import { cloudBearerChallenge } from "./cloud-oauth";
import {
  mutateCloudImport,
  readCloudImport,
  resolveCloudImportPrincipal,
  type CloudImportAction,
} from "./cloud-imports";
import { ExomemHostedError, safeErrorResponse } from "./errors";
import { readBoundedJsonRequest } from "./http";
import type { CloudHomeDependencies } from "./cloud-home-mcp";

export async function handleCloudImportRequest(
  request: Request,
  action: CloudImportAction,
  importId?: string,
  dependencies: CloudHomeDependencies = {}
): Promise<Response> {
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  try {
    const principal = await resolveCloudImportPrincipal(request);
    if (action === "status")
      return Response.json(await readCloudImport(principal, importId, dependencies), { headers });
    const body =
      action === "cancel" || action === "discard"
        ? undefined
        : await readBoundedJsonRequest(request, 2 * 1024 * 1024);
    const result = await mutateCloudImport(principal, action, body, importId);
    return Response.json(
      { import: result.import, limits: result.limits, storage: result.storage },
      { status: result.created ? 201 : 200, headers }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    if (error instanceof ExomemHostedError && error.status === 401) {
      response.headers.set("www-authenticate", cloudBearerChallenge(loadExomemCloudResource()));
    }
    return response;
  }
}
