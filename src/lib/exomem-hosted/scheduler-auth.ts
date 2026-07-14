import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

const ACTIVE_SECRET = "EXOMEM_HOSTED_SCHEDULER_SECRET";
const PREVIOUS_SECRET = "EXOMEM_HOSTED_SCHEDULER_SECRET_PREVIOUS";

function constantTimeEqual(provided: string, expected: string): boolean {
  const candidate = Buffer.from(provided, "utf8");
  const reference = Buffer.from(expected, "utf8");
  return candidate.length === reference.length && timingSafeEqual(candidate, reference);
}

/** Authenticate only the three externally scheduled Exomem jobs.
 *
 * The global CRON_SECRET deliberately has no authority here. One explicit
 * previous receiver value permits a staged Vercel/K3s rotation; no larger key
 * ring or implicit fallback is accepted.
 */
export function verifyHostedSchedulerAuth(request: NextRequest): { ok: boolean } {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return { ok: false };
  const provided = header.slice("bearer ".length).trim();
  if (!provided) return { ok: false };
  const active = process.env[ACTIVE_SECRET];
  if (!active) return { ok: false };
  const accepted = [active, process.env[PREVIOUS_SECRET]].filter((secret): secret is string =>
    Boolean(secret)
  );
  return { ok: accepted.some((secret) => constantTimeEqual(provided, secret)) };
}
