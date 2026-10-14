import { randomUUID } from "node:crypto";
import { sendTransactionalEmail } from "../brevo";
import { EXOMEM_SENDER } from "./mail-sender";
import {
  proveControlRoundTrip,
  readHealthProof,
  saveHealthProof,
  type HealthComponent,
} from "./functional-health-store";

export function healthFreshnessSeconds(component: HealthComponent): number {
  // Defaults follow the scheduler cadence; operators can tune freshness through configuration.
  const defaults = { control: 180, email: 3600, memory: 180 };
  const value = Number(
    process.env[`EXOMEM_HEALTH_${component.toUpperCase()}_FRESHNESS_SECONDS`] ?? defaults[component]
  );
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("INVALID_HEALTH_FRESHNESS");
  return component === "email" ? Math.min(value, 3600) : value;
}

export async function functionalHealthResponse(component: HealthComponent): Promise<Response> {
  let ok = false;
  try {
    const freshness = healthFreshnessSeconds(component) * 1000;
    const proof = await readHealthProof(component);
    const now = Date.now();
    ok = Boolean(
      proof?.success &&
      proof.startedAt.getTime() <= now &&
      proof.checkedAt.getTime() <= now &&
      now - proof.checkedAt.getTime() < freshness
    );
  } catch {
    /* Missing configuration or unreadable evidence cannot certify an operation. */
  }
  return Response.json(
    { ok },
    {
      status: ok ? 200 : 503,
      headers: { "cache-control": "no-store, max-age=0" },
    }
  );
}

export async function runFunctionalHealthCheck(
  component: HealthComponent,
  operation: () => Promise<boolean>
): Promise<boolean> {
  const startedAt = new Date();
  const runId = randomUUID();
  let success = false;
  try {
    success = await operation();
  } catch {
    /* Store one final failed result for this attempt. */
  }
  try {
    await saveHealthProof({ component, runId, startedAt, checkedAt: new Date(), success });
    return success;
  } catch {
    return false;
  }
}

export function runControlHealthCheck(): Promise<boolean> {
  return runFunctionalHealthCheck("control", proveControlRoundTrip);
}

export function runEmailHealthCheck(): Promise<boolean> {
  return runFunctionalHealthCheck("email", async () => {
    const recipient = process.env.EXOMEM_HEALTH_EMAIL_RECIPIENT?.trim();
    if (!recipient) return false;
    const result = await sendTransactionalEmail({
      to: recipient,
      subject: "Exomem transactional email health check",
      htmlContent: "<p>This synthetic check measures provider acceptance, not inbox delivery.</p>",
      textContent: "This synthetic check measures provider acceptance, not inbox delivery.",
      ...EXOMEM_SENDER,
    });
    return (
      result.success && typeof result.messageId === "string" && result.messageId.trim().length > 0
    );
  });
}
