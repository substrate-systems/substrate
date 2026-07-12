export type HostedErrorBody = {
  code: string;
  message: string;
  retryable?: boolean;
  requestId?: string;
};

export class HostedBrowserError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(error: HostedErrorBody, status: number) {
    super(error.message || "That did not work. Please try again.");
    this.name = "HostedBrowserError";
    this.code = error.code || "REQUEST_FAILED";
    this.retryable = Boolean(error.retryable);
    this.status = status;
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

export async function postPrivateFile(
  file: File,
  options: { idempotencyKey: string }
): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.set("file", file);
  form.set("scope", "inbox");
  form.set("category", "uploads");
  form.set("filename", file.name);
  const response = await fetch("/api/exomem/upload", {
    method: "POST",
    headers: {
      "x-exomem-csrf": csrfCookie(),
      "idempotency-key": options.idempotencyKey,
    },
    body: form,
    credentials: "same-origin",
    cache: "no-store",
  });
  return decodeResponse(response);
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
  return error.message;
}
