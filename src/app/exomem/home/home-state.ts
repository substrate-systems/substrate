export type LifecycleState =
  | "loading"
  | "preparing"
  | "ready"
  | "degraded"
  | "suspended"
  | "deletion_pending"
  | "deleted";

export type Lifecycle = {
  state: LifecycleState;
  code: string;
  retryable: boolean;
  requestId?: string;
};

export function createSingleFlight<T>(): (load: () => Promise<T>) => Promise<T> {
  let pending: Promise<T> | null = null;
  return (load) => {
    if (pending) return pending;
    const request = load();
    pending = request;
    const clear = () => {
      if (pending === request) pending = null;
    };
    void request.then(clear, clear);
    return request;
  };
}

const SERVER_LIFECYCLE_STATES = new Set<LifecycleState>([
  "preparing",
  "ready",
  "degraded",
  "suspended",
  "deletion_pending",
  "deleted",
]);

export function parseLifecycleResponse(value: unknown): Lifecycle | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;

  const candidate = status as Record<string, unknown>;
  if (
    typeof candidate.state !== "string" ||
    !SERVER_LIFECYCLE_STATES.has(candidate.state as LifecycleState)
  ) {
    return null;
  }

  const requestId =
    typeof candidate.requestId === "string" && candidate.requestId.length <= 128
      ? candidate.requestId
      : undefined;
  return {
    state: candidate.state as LifecycleState,
    code: typeof candidate.code === "string" ? candidate.code : "CELL_UNAVAILABLE",
    retryable: candidate.retryable === true,
    ...(requestId ? { requestId } : {}),
  };
}

export function nextStatusPollDelayMs(lifecycle: Lifecycle, attempt: number): number | null {
  if (lifecycle.state === "ready" || lifecycle.state === "deleted") return null;
  const exponent = Math.max(0, Math.min(4, Math.floor(attempt)));
  return Math.min(30_000, 3_000 * 2 ** exponent);
}
