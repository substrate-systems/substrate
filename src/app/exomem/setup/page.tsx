import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadExomemAccountView } from "@/lib/exomem-hosted/account-view";
import { loadExomemCloudResource } from "@/lib/exomem-hosted/cloud-config";
import { getOwnerCloudStatus } from "@/lib/exomem-hosted/cloud-status";
import { connectorSettingsUrl } from "@/lib/exomem-hosted/consent-view";
import { findExomemSessionByDigest } from "@/lib/exomem-hosted/db";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import { EXOMEM_SESSION_COOKIE } from "@/lib/exomem-hosted/sessions";
import SetupClient, { type SetupFacts } from "./setup-client";
import { setupScreen } from "./setup-screen";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Set up Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

// The MCP address an app without the plugin pastes: the Cloud URL from configuration
// (deviation (h)). Unconfigured is a visible gap on the page, not a guessed address.
function mcpAddress(): string | null {
  try {
    return loadExomemCloudResource().mcpUrl;
  } catch {
    return null;
  }
}

async function setupFacts(sessionCookie: string | undefined): Promise<SetupFacts | null> {
  const digest = sessionCookie ? tokenDigest(sessionCookie) : null;
  if (!digest) return null;
  const session = await findExomemSessionByDigest(digest);
  if (!session) return null;
  const [account, status] = await Promise.all([
    loadExomemAccountView(session),
    getOwnerCloudStatus(session.tenantId),
  ]);
  const screen = setupScreen(account.step, status.state);
  if (!screen) return null;
  return {
    screen,
    email: account.email,
    keptUntil: account.keptUntil,
    supportReference: account.supportReference,
    mcpAddress: mcpAddress(),
    // Where "Open Claude ↗" and "Open ChatGPT ↗" go: configuration, as on the consent page.
    settings: {
      claude: connectorSettingsUrl("claude", false).value,
      openai: connectorSettingsUrl("openai", false).value,
    },
  };
}

/** The web journey after sign-in: subscribe, then add Exomem to an assistant. */
export default async function SetupPage() {
  const cookieStore = await cookies();
  const facts = await setupFacts(cookieStore.get(EXOMEM_SESSION_COOKIE)?.value);
  if (!facts) redirect("/exomem/sign-in");
  return <SetupClient facts={facts} />;
}
