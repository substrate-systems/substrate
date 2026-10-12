/**
 * The sign-in link request is "Start with your email" under its earlier
 * path, so no caller can reach a sign-in email without the Turnstile check.
 */
export { POST } from "../start/route";

// Route segment config must be literal in each route file.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
