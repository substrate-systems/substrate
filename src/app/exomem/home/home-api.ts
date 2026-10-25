// The routes Home reads and writes, and the shapes it accepts from them. A response
// that does not have the expected shape reads as unknown or unavailable: Home shows
// that state instead of guessing a value.
//
// The types are the server modules' own (type-only imports), so a route and Home
// cannot drift apart without the type check noticing.

import type { ExomemAccountView } from "@/lib/exomem-hosted/account-view";
import type { OwnerBillingSummary } from "@/lib/exomem-hosted/billing-account";
import type {
  CloudHomeActivityView,
  CloudHomeContext,
  CloudHomeLevel,
  CloudHomeLevelsView,
} from "@/lib/exomem-hosted/cloud-home-mcp";
import type { CloudExportSummary } from "@/lib/exomem-hosted/cloud-exports";
import { isExomemMoney } from "@/lib/exomem/money";
import type { CloudStorageObservation } from "@/lib/exomem-hosted/cloud-status";
import { csrfCookie, getPrivateJson, HostedBrowserError } from "@/lib/exomem-hosted/hosted-browser";
import type { OwnerApp } from "@/lib/exomem-hosted/owner-apps";
import type { loadExomemEmailChange } from "@/lib/exomem-hosted/email-change";
import type { loadPaddleReceiptContact } from "@/lib/exomem-hosted/paddle-receipt-contact";
import { postPrivateJson } from "@/lib/exomem-hosted/hosted-browser";
import { type Lifecycle, parseCloudConnectorUrl, parseLifecycleResponse } from "./home-state";

export type HomeAccount = ExomemAccountView;
export type HomeBilling = OwnerBillingSummary;
export type HomeApp = OwnerApp;
export type HomeLevels = CloudHomeLevelsView;
export type HomeActivity = CloudHomeActivityView;
export type HomeExport = CloudExportSummary;
export type HomeStorage = CloudStorageObservation;
export type LevelContext = CloudHomeContext;
export type LevelKey = CloudHomeLevel;

/** A Home feature whose release flag is off: its route answers 404. Home leaves it out. */
export const NOT_RELEASED = "not_released" as const;

/** The session ended (401): the page goes to sign-in. */
export class SignedOutError extends Error {
  constructor() {
    super("signed out");
    this.name = "SignedOutError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isKnown(value: unknown): boolean {
  const known = record(value);
  return (
    known !== null &&
    ((known.reason === null && known.value !== null && known.value !== undefined) ||
      (known.value === null && typeof known.reason === "string"))
  );
}

async function read(path: string): Promise<Record<string, unknown>> {
  try {
    return await getPrivateJson(path);
  } catch (error) {
    if (error instanceof HostedBrowserError && error.status === 401) throw new SignedOutError();
    throw error;
  }
}

/** A JSON mutation that keeps the status and body of a refusal, which `postPrivateJson` drops. */
async function send(
  method: "POST" | "PUT",
  path: string,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> | null; date: string | null }> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-exomem-csrf": csrfCookie() },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) throw new SignedOutError();
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  return { status: response.status, body: record(parsed), date: response.headers.get("date") };
}

/** The refusal code and retry hint in an error envelope, when it has them. */
function refusal(body: Record<string, unknown> | null): {
  code: string | null;
  retryAfterMs: number | null;
} {
  const error = record(body?.error);
  return {
    code: typeof error?.code === "string" ? error.code : null,
    retryAfterMs: typeof error?.retryAfterMs === "number" ? error.retryAfterMs : null,
  };
}

// --- Status poll: lifecycle, measured storage, the export row, the MCP address ---

export type StatusRead = {
  lifecycle: Lifecycle;
  /** The cell-state precondition; import routes still check owner authority. */
  importAvailable: boolean;
  storage: HomeStorage | null;
  /** NOT_RELEASED while the export flag is off: the poll leaves the export out. */
  exportSummary: HomeExport | typeof NOT_RELEASED | null;
  connectorUrl: string | null;
};

function parseStorage(value: unknown): HomeStorage | null {
  const storage = record(value);
  if (storage?.state === "unknown") return { state: "unknown" };
  if (
    storage?.state === "known" &&
    typeof storage.used_bytes === "number" &&
    typeof storage.filesystem_bytes === "number" &&
    storage.filesystem_bytes > 0 &&
    typeof storage.observed_at === "string"
  ) {
    return storage as HomeStorage;
  }
  return null;
}

const EXPORT_STATES = new Set(["none", "packing", "ready", "expired", "failed"]);

function parseExport(value: unknown): HomeExport | null {
  const summary = record(value);
  if (!summary || typeof summary.pauses_assistants !== "boolean") return null;
  if (typeof summary.state !== "string" || !EXPORT_STATES.has(summary.state)) return null;
  if (summary.state !== "none" && typeof summary.export_id !== "string") return null;
  if (
    summary.state === "ready" &&
    (typeof summary.expires_at !== "string" || typeof summary.ready_at !== "string")
  ) {
    return null;
  }
  if (summary.state === "failed" && typeof summary.error_code !== "string") return null;
  return summary as HomeExport;
}

export async function readStatus(): Promise<StatusRead> {
  const response = await read("/api/exomem/status");
  const lifecycle = parseLifecycleResponse(response);
  if (!lifecycle) throw new Error("invalid status");
  return {
    lifecycle,
    importAvailable: response.importAvailable === true,
    storage: parseStorage(response.storage),
    exportSummary: "export" in response ? parseExport(response.export) : NOT_RELEASED,
    connectorUrl: parseCloudConnectorUrl(response),
  };
}

// --- Account: plan, dates, support reference; billing actions ---

export async function readAccount(): Promise<{
  account: HomeAccount | null;
  billing: HomeBilling | null;
  csrfToken: string;
}> {
  // A late response may describe a previous session. Its view and pre-request nonce stay paired.
  const csrfToken = csrfCookie();
  const response = await read("/api/exomem/account");
  const account = record(response.account);
  const plan = record(account?.plan);
  const accountOk =
    account !== null &&
    (account.kind === "owner" || account.kind === "reviewer") &&
    typeof account.email === "string" &&
    typeof account.supportReference === "string" &&
    typeof account.step === "string" &&
    plan !== null &&
    isKnown(plan.name) &&
    // Whether checkout applies a friend price decides which price Home may show.
    typeof record(plan.friendPrice)?.offered === "boolean" &&
    [
      "nextPaymentAt",
      "nextPaymentAmount",
      "readOnlyUntil",
      "keptUntil",
      "endedAt",
      "reviewerEndsAt",
    ].every((key) => isKnown(account[key])) &&
    // An amount must have the server's shape: an empty or non-numeric one is unreadable.
    (record(account.nextPaymentAmount)?.value === null ||
      isExomemMoney(record(account.nextPaymentAmount)?.value));
  const billing = record(response.billing);
  const billingOk =
    billing !== null &&
    (billing.source === "complimentary" || billing.source === "paddle") &&
    typeof billing.checkoutAvailable === "boolean" &&
    typeof billing.portalAvailable === "boolean";
  return {
    account: accountOk ? (account as HomeAccount) : null,
    billing: billingOk ? (billing as HomeBilling) : null,
    csrfToken,
  };
}

export type HomeEmailChange = {
  pending: Awaited<ReturnType<typeof loadExomemEmailChange>>;
  receipts: Awaited<ReturnType<typeof loadPaddleReceiptContact>>;
};

export async function readEmailChange(): Promise<HomeEmailChange | null> {
  const response = await read("/api/exomem/account/email-change");
  const pending = record(response.pending);
  const receipts = record(response.receipts);
  // These states are fixed by the outbox schema, not inferred from message text.
  const deliveryStates = new Set(["pending", "leased", "sent", "failed", "cancelled"]);
  // The receipt projection schema fixes these synchronization states.
  const receiptStates = new Set(["pending", "synchronized", "conflict", "failed"]);
  const delivery = record(pending?.delivery);
  const pendingOk =
    response.pending === null ||
    (pending !== null &&
      typeof pending.requestId === "string" &&
      pending.requestId.length > 0 &&
      typeof pending.proposedEmail === "string" &&
      typeof pending.expiresAt === "string" &&
      Number.isFinite(Date.parse(pending.expiresAt)) &&
      (pending.delivery === null ||
        (delivery !== null &&
          Object.values(delivery).every(
            (state) => typeof state === "string" && deliveryStates.has(state)
          ))));
  const receiptsOk =
    response.receipts === null ||
    (receipts !== null &&
      (receipts.state === null ||
        (typeof receipts.state === "string" && receiptStates.has(receipts.state))) &&
      typeof receipts.available === "boolean" &&
      (receipts.knownEmail === null || typeof receipts.knownEmail === "string") &&
      (receipts.observedAt === null ||
        (typeof receipts.observedAt === "string" &&
          Number.isFinite(Date.parse(receipts.observedAt)))) &&
      (receipts.observationSource === null || receipts.observationSource === "paddle_customer") &&
      (receipts.errorCode === null || typeof receipts.errorCode === "string"));
  return response.success === true && pendingOk && receiptsOk
    ? (response as unknown as HomeEmailChange)
    : null;
}

/** The frozen nonce prevents an old form from using a newly signed-in account's authority. */
export async function requestEmailChange(
  email: string,
  csrfToken: string
): Promise<{ requestId: string; expiresAt: string } | null> {
  const current = () => csrfToken !== "" && csrfToken === csrfCookie();
  if (!current()) return null;
  let response: Record<string, unknown>;
  try {
    response = await postPrivateJson("/api/exomem/account/email-change", { email }, "POST", {
      csrfToken,
    });
  } catch (error) {
    if (!current()) return null;
    throw error;
  }
  if (!current()) return null;
  if (
    response.success !== true ||
    response.state !== "pending" ||
    response.delivery !== "queued" ||
    typeof response.requestId !== "string" ||
    response.requestId.length === 0 ||
    typeof response.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(response.expiresAt))
  )
    throw new Error("Email change was not queued");
  return { requestId: response.requestId, expiresAt: response.expiresAt };
}

/** Opens Paddle checkout or the customer portal; resolves with the address to go to. */
export async function billingDestination(kind: "checkout" | "portal"): Promise<string | null> {
  const { status, body } = await send("POST", `/api/exomem/billing/${kind}`, {});
  if (status < 200 || status >= 300 || !body) return null;
  const destination = kind === "checkout" ? body.checkoutUrl : body.portalUrl;
  return typeof destination === "string" ? destination : null;
}

// --- Connected apps ---

export async function readApps(): Promise<HomeApp[] | null> {
  const response = await read("/api/exomem/apps");
  if (!Array.isArray(response.apps)) return null;
  return response.apps.filter((app): app is HomeApp => {
    const candidate = record(app);
    return (
      candidate !== null &&
      typeof candidate.id === "string" &&
      typeof candidate.displayName === "string" &&
      typeof candidate.connectedAt === "string" &&
      (candidate.kind === "web" || candidate.kind === "local") &&
      Array.isArray(candidate.redirectHosts)
    );
  });
}

/** True when the app is disconnected now or was already; false when the server refused. */
export async function disconnectApp(id: string): Promise<"disconnected" | "gone" | "failed"> {
  const { status } = await send(
    "POST",
    `/api/exomem/apps/${encodeURIComponent(id)}/disconnect`,
    {}
  );
  if (status === 200) return "disconnected";
  if (status === 404) return "gone";
  return "failed";
}

// --- The Home channel: levels and live activity, through the owner's cell ---

const UNREACHABLE = { state: "unavailable", reason: "CELL_UNREACHABLE" } as const;

function parseLevels(value: unknown): HomeLevels | null {
  const view = record(value);
  if (view?.state === "unavailable" && typeof view.reason === "string") return view as HomeLevels;
  const levels = record(view?.levels);
  if (
    view?.state === "live" &&
    typeof view.revision === "string" &&
    typeof view.writable === "boolean" &&
    record(levels?.coding) !== null &&
    record(levels?.conversation) !== null
  ) {
    return view as HomeLevels;
  }
  return null;
}

async function readChannel<T>(
  path: string,
  parse: (value: unknown) => T | null
): Promise<T | typeof UNREACHABLE | typeof NOT_RELEASED> {
  try {
    return parse(await read(path)) ?? UNREACHABLE;
  } catch (error) {
    if (error instanceof SignedOutError) throw error;
    if (error instanceof HostedBrowserError && error.status === 404) return NOT_RELEASED;
    return UNREACHABLE;
  }
}

export function readLevels(): Promise<HomeLevels | typeof NOT_RELEASED> {
  return readChannel("/api/exomem/cloud/home/levels", parseLevels);
}

export type LevelWrite =
  | { kind: "written"; view: HomeLevels }
  | { kind: "refused"; code: string; view: HomeLevels | null }
  | { kind: "failed"; view: HomeLevels | null };

export async function writeLevel(
  context: LevelContext,
  level: LevelKey,
  expectedRevision: string
): Promise<LevelWrite> {
  const { status, body } = await send("PUT", "/api/exomem/cloud/home/levels", {
    context,
    level,
    expected_revision: expectedRevision,
  });
  if (status === 200) {
    const view = parseLevels(body);
    return view ? { kind: "written", view } : { kind: "failed", view: null };
  }
  if (status === 409) {
    return {
      kind: "refused",
      code: refusal(body).code ?? "PREFERENCE_CONFLICT",
      view: parseLevels(body?.current),
    };
  }
  // 503 carries the unavailable view.
  return { kind: "failed", view: parseLevels(body) };
}

function parseActivity(value: unknown): HomeActivity | null {
  const view = record(value);
  if (view?.state === "unavailable" && typeof view.reason === "string") {
    return view as HomeActivity;
  }
  if (
    view?.state === "live" &&
    typeof view.since === "string" &&
    typeof view.as_of === "string" &&
    (view.note_count === null || typeof view.note_count === "number") &&
    Array.isArray(view.events)
  ) {
    return view as HomeActivity;
  }
  return null;
}

export function readActivity(): Promise<HomeActivity | typeof NOT_RELEASED> {
  return readChannel("/api/exomem/cloud/home/live", parseActivity);
}

// --- Export ---

export type ExportStart =
  | { kind: "started"; summary: HomeExport }
  | { kind: "refused"; code: string; retryAfterMs: number | null };

export async function startExport(exportId: string): Promise<ExportStart> {
  const { status, body } = await send("POST", "/api/exomem/cloud/exports", {
    export_id: exportId,
  });
  if (status === 200 || status === 201) {
    const summary = parseExport(body?.export);
    if (summary) return { kind: "started", summary };
  }
  const { code, retryAfterMs } = refusal(body);
  return { kind: "refused", code: code ?? "REQUEST_FAILED", retryAfterMs };
}

export type ExportLink =
  | { kind: "link"; url: string }
  | { kind: "pending" }
  | { kind: "refused"; code: string };

/** Asks for a fresh, short-lived download link. Never stored: it is used at once. */
export async function requestExportLink(exportId: string): Promise<ExportLink> {
  const { status, body } = await send(
    "POST",
    `/api/exomem/cloud/exports/${encodeURIComponent(exportId)}/link`,
    {}
  );
  if (status === 200 && typeof body?.url === "string") return { kind: "link", url: body.url };
  if (status === 202) return { kind: "pending" };
  return { kind: "refused", code: refusal(body).code ?? "REQUEST_FAILED" };
}

// --- Account actions ---

/**
 * Sends a fresh deletion confirmation. Resolves with the link's expiry and the
 * server's time when it answered (its Date header), so Home can say how long the
 * link works without trusting the browser's clock.
 */
export async function requestDeletion(): Promise<{
  ok: boolean;
  expiresAt: string | null;
  serverDate: string | null;
}> {
  const { status, body, date } = await send("POST", "/api/exomem/deletion/request", {});
  return {
    ok: status >= 200 && status < 300,
    expiresAt: typeof body?.expiresAt === "string" ? body.expiresAt : null,
    serverDate: date,
  };
}

export async function signOut(): Promise<boolean> {
  try {
    const { status } = await send("POST", "/api/exomem/access/logout", {});
    return status >= 200 && status < 300;
  } catch (error) {
    // A session that already ended is signed out.
    if (error instanceof SignedOutError) return true;
    throw error;
  }
}
