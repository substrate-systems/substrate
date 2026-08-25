export type LifecycleState =
  | "loading"
  | "awaiting_payment"
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

export type InstallAction = {
  platform: "claude" | "openai";
  version: string;
  installUrl: string;
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
  "awaiting_payment",
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

export function parseInstallActions(value: unknown): InstallAction[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const actions = (value as Record<string, unknown>).installActions;
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) return [];
    const candidate = action as Record<string, unknown>;
    if (
      (candidate.platform !== "claude" && candidate.platform !== "openai") ||
      typeof candidate.version !== "string" ||
      !candidate.version ||
      typeof candidate.installUrl !== "string"
    ) {
      return [];
    }
    try {
      const installUrl = new URL(candidate.installUrl);
      if (
        installUrl.protocol !== "https:" ||
        installUrl.username ||
        installUrl.password ||
        installUrl.search ||
        installUrl.hash ||
        /(?:bearer|cell|mcp|secret|tenant|token)/i.test(installUrl.toString())
      ) {
        return [];
      }
      return [
        {
          platform: candidate.platform,
          version: candidate.version,
          installUrl: installUrl.href,
        },
      ];
    } catch {
      return [];
    }
  });
}

export function nextStatusPollDelayMs(lifecycle: Lifecycle, attempt: number): number | null {
  if (
    lifecycle.state === "awaiting_payment" ||
    lifecycle.state === "ready" ||
    lifecycle.state === "deleted"
  )
    return null;
  const exponent = Math.max(0, Math.min(4, Math.floor(attempt)));
  return Math.min(30_000, 3_000 * 2 ** exponent);
}
