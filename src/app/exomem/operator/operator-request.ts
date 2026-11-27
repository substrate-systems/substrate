/** The operator pages' one request: the admin bearer in a header, the answer as JSON, a coded error on failure. */

type OperatorErrorBody = {
  error?: { code?: unknown };
};

export class OperatorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

export async function operatorRequest(
  path: string,
  bearer: string,
  init: { method?: "POST"; body?: string } = {}
): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: {
      Authorization: `Bearer ${bearer}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as OperatorErrorBody &
    Record<string, unknown>;
  if (!response.ok) {
    throw new OperatorRequestError(
      response.status,
      typeof body.error?.code === "string" ? body.error.code : "OPERATOR_REQUEST_FAILED"
    );
  }
  return body;
}
