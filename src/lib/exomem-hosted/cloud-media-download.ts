/**
 * `GET /api/exomem/cloud/download?path=...`: a signed-in owner's link to one stored
 * original (add-cloud-media-access). The bytes never pass through this app. The
 * route checks the browser session, picks the cell from the session alone, and
 * answers 302 to the gateway's `/download` with a ticket for exactly this path.
 * The ticket lives long enough for a recording, because a media element sends
 * every later Range request to the address it first followed.
 */

import { CLOUD_DOWNLOAD_PATH } from "../../exomem-gateway/cloud-origin";
import { controlPlaneKeyFromEnv } from "./security";
import { loadExomemCloudResource, type EnvironmentSource } from "./cloud-config";
import { downloadTicketLifetimeSeconds, signDownloadTicket } from "./cloud-download-ticket";
import { openHomeLoginForTicket, servingCell } from "./cloud-home-mcp";
import { ExomemHostedError, exomemErrors } from "./errors";
import { PRIVATE_NO_STORE_HEADERS } from "./http";
import { safeErrorResponse } from "./next-error-response";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "./rate-limit";
import { resolveExomemSession } from "./sessions";

// Longer than any vault path the cell accepts, short enough for a URL every proxy carries.
const MAX_PATH_CHARS = 4096;

export type CloudMediaDownloadDependencies = { env?: EnvironmentSource };

const unavailableCell = (reason: string) =>
  new ExomemHostedError({
    code: reason,
    status: 503,
    message: "your stored files cannot be reached right now",
    retryable: reason === "CELL_NOT_READY",
  });

/**
 * A GET carries no CSRF header, and the session cookie is `SameSite=Lax`, so a
 * link on another site could still send it with a top-level navigation. The
 * browser's own request metadata says where the request began: this site's own
 * pages (`same-origin`) and a typed address or bookmark (`none`) may ask, and so
 * may a link that the owner follows from another site (a web chat client shows
 * one), which is a cross-site navigation of a document. That request cannot read
 * the answer: it only navigates to the gateway, which serves an attachment under
 * a sandbox policy. Every other cross-site request (an image, a script, a fetch,
 * a frame) is refused. A browser too old to send `Sec-Fetch-Site` still sends
 * `Origin` on a cross-origin request, so that is read when the metadata is absent.
 */
function assertOwnBrowserRequest(request: Request): void {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) {
    if (site === "same-origin" || site === "none") return;
    const navigatesToDocument =
      site === "cross-site" &&
      request.headers.get("sec-fetch-mode") === "navigate" &&
      request.headers.get("sec-fetch-dest") === "document";
    if (!navigatesToDocument) throw exomemErrors.csrfRejected();
    return;
  }
  const origin = request.headers.get("origin");
  if (origin === null) return;
  const host = request.headers.get("host");
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw exomemErrors.csrfRejected();
  }
  if (host === null || originHost !== host.toLowerCase()) throw exomemErrors.csrfRejected();
}

function respondError(error: unknown): Response {
  const response = safeErrorResponse(error);
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export async function handleCloudMediaDownloadRequest(
  request: Request,
  dependencies: CloudMediaDownloadDependencies = {}
): Promise<Response> {
  try {
    assertOwnBrowserRequest(request);
    const session = await resolveExomemSession(request);
    // A reviewer's session is a provider's short window onto a sample account: no stored files leave through it.
    if (session.reviewerCredentialId) throw exomemErrors.entitlementDenied();

    const paths = new URL(request.url).searchParams.getAll("path");
    if (paths.length !== 1 || paths[0] === "" || paths[0].length > MAX_PATH_CHARS) {
      throw exomemErrors.invalidRequest();
    }
    const path = paths[0];

    if (!(await takeExomemRateLimit(EXOMEM_RATE_LIMITS.ownerMediaTicketTenant, session.tenantId))) {
      throw exomemErrors.rateLimited();
    }
    // The cell is the session tenant's own, read from the database; nothing in the request names one.
    const cell = await servingCell(session);
    if (cell.state !== "serving") throw unavailableCell(cell.reason);

    const { mcpUrl, acceptedResources } = loadExomemCloudResource(dependencies.env);
    const lifetimeSeconds = downloadTicketLifetimeSeconds(dependencies.env);
    const login = await openHomeLoginForTicket(session, mcpUrl, acceptedResources, lifetimeSeconds);
    if ("refused" in login) {
      throw login.refused === "ACCOUNT_ACCESS_CLOSED"
        ? exomemErrors.entitlementDenied()
        : unavailableCell(login.refused);
    }

    const ticket = signDownloadTicket(
      {
        tenantId: session.tenantId,
        cellId: cell.cellId,
        familyId: login.familyId,
        grantId: login.grantId,
        path,
      },
      controlPlaneKeyFromEnv(),
      { lifetimeSeconds }
    );
    const location = new URL(CLOUD_DOWNLOAD_PATH, mcpUrl);
    location.search = new URLSearchParams({ path, ticket }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        ...PRIVATE_NO_STORE_HEADERS,
        // The gateway address carries the ticket; no page it opens may learn it.
        "referrer-policy": "no-referrer",
        location: location.toString(),
      },
    });
  } catch (error) {
    return respondError(error);
  }
}
