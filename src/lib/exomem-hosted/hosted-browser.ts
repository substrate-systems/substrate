export type HostedErrorBody = {
  code: string;
  message: string;
  retryable?: boolean;
  requestId?: string;
  remediation?: string;
};

export class HostedBrowserError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  // The cell computes a remediation for refusals a person can act on. It was
  // being dropped here, so a fixable refusal read as an unexplained failure.
  readonly remediation?: string;

  constructor(error: HostedErrorBody, status: number) {
    super(error.message || "That did not work. Please try again.");
    this.name = "HostedBrowserError";
    this.code = error.code || "REQUEST_FAILED";
    this.retryable = Boolean(error.retryable);
    this.status = status;
    if (error.remediation) this.remediation = error.remediation;
  }
}

function errorFrom(value: unknown): HostedErrorBody {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const body = value as Record<string, unknown>;
    const nested = body.error;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const error = nested as Record<string, unknown>;
      return {
        code: typeof error.code === "string" ? error.code : "REQUEST_FAILED",
        message:
          typeof error.message === "string"
            ? error.message
            : "That did not work. Please try again.",
        retryable: error.retryable === true,
        requestId: typeof error.requestId === "string" ? error.requestId : undefined,
        remediation: typeof error.remediation === "string" ? error.remediation : undefined,
      };
    }
  }
  return { code: "REQUEST_FAILED", message: "That did not work. Please try again." };
}

async function decodeResponse(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || !body || typeof body !== "object" || Array.isArray(body)) {
    throw new HostedBrowserError(errorFrom(body), response.status);
  }
  return body as Record<string, unknown>;
}

export async function postPublicJson(
  path: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  return decodeResponse(response);
}

export function csrfCookie(): string {
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === "exomem_csrf") return decodeURIComponent(rest.join("="));
  }
  return "";
}

export async function postPrivateJson(
  path: string,
  body: Record<string, unknown>,
  options: { idempotencyKey?: string } = {}
): Promise<Record<string, unknown>> {
  const csrf = csrfCookie();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-exomem-csrf": csrf,
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  return decodeResponse(response);
}

export async function getPrivateJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  return decodeResponse(response);
}

type DirectTransferTicket = {
  url: string;
  method: "PUT" | "GET";
  headers: Record<string, string>;
  maxBytes: number;
};

const HOSTED_UPLOAD_MAX_BYTES = 90 * 1024 * 1024;
const DOWNLOAD_DISPOSITION =
  /^attachment; filename="exomem-download"; filename\*=UTF-8''(?:[A-Za-z0-9!#$&+.^_`|~-]|%[0-9A-F]{2})+$/;

function readDirectTransferTicket(
  response: Record<string, unknown>,
  expectedMethod: "PUT" | "GET"
): DirectTransferTicket {
  const data = response.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  const ticket = data as Record<string, unknown>;
  const headers = ticket.headers;
  let url: URL;
  try {
    url = new URL(String(ticket.url));
  } catch {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  if (
    ticket.method !== expectedMethod ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !Number.isSafeInteger(ticket.maxBytes) ||
    Number(ticket.maxBytes) <= 0 ||
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers)
  ) {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
  if (
    Object.keys(normalizedHeaders).length !== Object.keys(headers).length ||
    typeof normalizedHeaders["X-Exomem-Transfer-Grant"] !== "string"
  ) {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  return {
    url: url.toString(),
    method: expectedMethod,
    headers: normalizedHeaders,
    maxBytes: Number(ticket.maxBytes),
  };
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readUploadCommitProof(
  response: Response,
  expectedBytes: number,
  expectedSha256: string
): Promise<Record<string, unknown>> {
  const body = await decodeResponse(response);
  const data = body.data;
  if (
    response.status !== 201 ||
    response.headers.get("content-type")?.split(";", 1)[0] !== "application/json" ||
    Object.keys(body).sort().join(",") !== "data,success" ||
    body.success !== true ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).sort().join(",") !== "bytes,committed,operation,sha256"
  ) {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  const proof = data as Record<string, unknown>;
  if (
    proof.operation !== "upload" ||
    proof.committed !== true ||
    !Number.isSafeInteger(proof.bytes) ||
    proof.bytes !== expectedBytes ||
    proof.sha256 !== expectedSha256
  ) {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  return body;
}

export async function postPrivateFile(file: File): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(file.size) || file.size > HOSTED_UPLOAD_MAX_BYTES) {
    throw new HostedBrowserError(
      {
        code: "TRANSFER_TOO_LARGE",
        message: "The selected file is larger than the 90 MiB hosted upload limit.",
      },
      413
    );
  }
  const contentType = file.type || "application/octet-stream";
  const filename = file.name.normalize("NFC");
  const sha256 = await sha256Hex(file);
  const ticketResponse = await postPrivateJson("/api/exomem/upload", {
    metadata: {
      category: "uploads",
      content_type: contentType,
      description: null,
      filename,
      scope: "inbox",
      sha256,
      size: file.size,
    },
  });
  const ticket = readDirectTransferTicket(ticketResponse, "PUT");
  if (
    Object.keys(ticket.headers).sort().join(",") !== "Content-Type,X-Exomem-Transfer-Grant" ||
    ticket.headers["Content-Type"] !== contentType ||
    file.size > ticket.maxBytes
  ) {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  const response = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers,
    body: file,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  return readUploadCommitProof(response, file.size, sha256);
}

// Adoption staging intake mirrors postPrivateFile (ticket → direct PUT →
// commit-proof check) but rides /api/exomem/adopt/upload, which binds the
// signed grant to the run's `_Staging/adoption/<run_id>/` landing. `path` is
// the optional relative subdirectory inside the staging area (for folder
// picks); ZIP expansion and its caps stay cell-side.
export async function postAdoptionFile(
  file: File,
  runId: string,
  path?: string | null
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(file.size) || file.size > HOSTED_UPLOAD_MAX_BYTES) {
    throw new HostedBrowserError(
      {
        code: "TRANSFER_TOO_LARGE",
        message: "The selected file is larger than the 90 MiB hosted upload limit.",
      },
      413
    );
  }
  const contentType = file.type || "application/octet-stream";
  const filename = file.name.normalize("NFC");
  const sha256 = await sha256Hex(file);
  const ticketResponse = await postPrivateJson("/api/exomem/adopt/upload", {
    metadata: {
      content_type: contentType,
      filename,
      path: path ? path.normalize("NFC") : null,
      run_id: runId,
      sha256,
      size: file.size,
    },
  });
  const ticket = readDirectTransferTicket(ticketResponse, "PUT");
  if (
    Object.keys(ticket.headers).sort().join(",") !== "Content-Type,X-Exomem-Transfer-Grant" ||
    ticket.headers["Content-Type"] !== contentType ||
    file.size > ticket.maxBytes
  ) {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  const response = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers,
    body: file,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  return readUploadCommitProof(response, file.size, sha256);
}

export async function getPrivateFile(path: string): Promise<Response> {
  const ticket = readDirectTransferTicket(
    await postPrivateJson("/api/exomem/download", { path }),
    "GET"
  );
  if (Object.keys(ticket.headers).join(",") !== "X-Exomem-Transfer-Grant") {
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  const response = await fetch(ticket.url, {
    method: ticket.method,
    headers: ticket.headers,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) await decodeResponse(response);
  const contentLength = response.headers.get("content-length");
  const contentDisposition = response.headers.get("content-disposition");
  const parsedLength =
    contentLength && /^(?:0|[1-9][0-9]*)$/.test(contentLength) ? Number(contentLength) : Number.NaN;
  if (
    response.status !== 200 ||
    response.headers.get("content-type") !== "application/octet-stream" ||
    !Number.isSafeInteger(parsedLength) ||
    parsedLength > ticket.maxBytes ||
    !contentDisposition ||
    !DOWNLOAD_DISPOSITION.test(contentDisposition)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new HostedBrowserError(errorFrom(null), 502);
  }
  return response;
}

const ADOPTION_COMMAND_PATH = "/api/exomem/commands/adoption_studio";
const REVIEW_MEMORY_PATH = "/api/exomem/commands/review_memory";
const REVIEW_ITEM_CONTEXT_PATH = "/api/exomem/commands/review_item_context";
const TRIAGE_MEMORY_PATH = "/api/exomem/commands/triage_memory";

export type AdoptionSelection = {
  include: string[];
  exclude: string[];
  overrides: string[];
  includeJunk: boolean;
};

// The registry classifies adoption_studio as a write command, so the hosted
// gateway requires an idempotency key on EVERY invocation — including the two
// per-invocation reads (status, work-item), where the cell ignores the key.
// Mutating actions take the caller's stable retry key so replays are safe.
export function startAdoptionRun(
  input: { path: string; initializeKb?: boolean },
  retryKey: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    { action: "start", path: input.path, initialize_kb: input.initializeKb ?? false },
    { idempotencyKey: retryKey }
  );
}

export function adoptionRunStatus(runId: string): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    { action: "status", run_id: runId },
    { idempotencyKey: newRetryKey() }
  );
}

export function selectAdoptionScope(
  runId: string,
  selection: AdoptionSelection,
  retryKey: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    {
      action: "select",
      run_id: runId,
      include: selection.include,
      exclude: selection.exclude,
      overrides: selection.overrides,
      include_junk: selection.includeJunk,
    },
    { idempotencyKey: retryKey }
  );
}

export function planAdoptionRun(runId: string, retryKey: string): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    { action: "plan", run_id: runId },
    { idempotencyKey: retryKey }
  );
}

export function applyAdoptionPlan(
  runId: string,
  planId: string,
  retryKey: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    { action: "apply", run_id: runId, plan_id: planId },
    { idempotencyKey: retryKey }
  );
}

// apply always echoes plan_id (even on retry): the engine refuses a
// mismatched/missing plan_id with PLAN_STALE regardless of retry_failed.
export function retryAdoptionApply(
  runId: string,
  planId: string,
  onlyPaths: string[],
  retryKey: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    {
      action: "apply",
      run_id: runId,
      plan_id: planId,
      retry_failed: true,
      only_paths: onlyPaths.length ? onlyPaths : null,
    },
    { idempotencyKey: retryKey }
  );
}

export function cancelAdoptionRun(
  runId: string,
  why: string,
  retryKey: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    { action: "cancel", run_id: runId, why: why || null },
    { idempotencyKey: retryKey }
  );
}

export function finishAdoptionRun(
  runId: string,
  retryKey: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    { action: "finish", run_id: runId },
    { idempotencyKey: retryKey }
  );
}

export function adoptionWorkItem(runId: string): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    { action: "work-item", run_id: runId },
    { idempotencyKey: newRetryKey() }
  );
}

// Scoped by the run's ref so a run's review screen never shows (or acts on)
// another run's proposals.
export function listAdoptionProposals(runRef: string | null): Promise<Record<string, unknown>> {
  return postPrivateJson(REVIEW_MEMORY_PATH, { mode: "adoption", ref: runRef || null, limit: 50 });
}

export function adoptionProposalContext(
  ref: string,
  expectedFingerprint: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(REVIEW_ITEM_CONTEXT_PATH, {
    ref,
    expected_fingerprint: expectedFingerprint,
  });
}

export function approveAdoptionProposal(
  input: { ref: string; expectedFingerprint: string; why: string; expectedHash?: string },
  retryKey: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(
    ADOPTION_COMMAND_PATH,
    {
      action: "apply-proposal",
      ref: input.ref,
      expected_fingerprint: input.expectedFingerprint,
      why: input.why,
      // Relation-kind approvals are CAS-guarded on the target page: echo the
      // content_hash the reviewer just inspected.
      expected_hash: input.expectedHash || null,
    },
    { idempotencyKey: retryKey }
  );
}

export function rejectAdoptionProposal(
  input: { ref: string; expectedFingerprint: string; why?: string },
  retryKey: string
): Promise<Record<string, unknown>> {
  return postPrivateJson(
    TRIAGE_MEMORY_PATH,
    {
      ref: input.ref,
      action: "dismiss",
      why: input.why || null,
      expected_fingerprint: input.expectedFingerprint,
    },
    { idempotencyKey: retryKey }
  );
}

export function takeFragmentToken(): string | null {
  const token = window.location.hash.slice(1).trim();
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return token || null;
}

export function inferMemoryTitle(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#{1,6}\s+/, ""))
    .find(Boolean);
  if (!firstLine) return "Untitled memory";
  const sentence = firstLine.split(/(?<=[.!?])\s/)[0].trim();
  return (
    (sentence.length > 80 ? `${sentence.slice(0, 77).trimEnd()}…` : sentence) || "Untitled memory"
  );
}

export function newRetryKey(): string {
  return crypto.randomUUID();
}

export function friendlyHostedError(error: unknown): string {
  if (!(error instanceof HostedBrowserError)) {
    return "Something went wrong. Please try again.";
  }
  if (error.code === "EXOMEM_SESSION_INVALID") return "Your sign-in has expired.";
  if (error.code === "CELL_UNAVAILABLE" || error.code === "CELL_MAPPING_MISSING") {
    return "Your Exomem is waking up. Give it a moment, then try again.";
  }
  if (error.code === "HOSTED_MUTATION_BUSY") {
    return "Another memory is being saved. Try once more in a moment.";
  }
  // Where the cell said what would fix it, say that. The cases above are the
  // ones we can phrase better than the cell can, because they are about the
  // session or the service rather than about the request.
  if (error.remediation) return `${error.message} ${error.remediation}`;
  return error.message;
}
