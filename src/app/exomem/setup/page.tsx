import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadExomemAccountView } from "@/lib/exomem-hosted/account-view";
import { CLIENT_PLATFORM_LISTING_URLS } from "@/lib/exomem-hosted/client-platforms";
import { ownerBillingSummary } from "@/lib/exomem-hosted/billing-account";
import { loadExomemCloudResource } from "@/lib/exomem-hosted/cloud-config";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { getOwnerCloudStatus } from "@/lib/exomem-hosted/cloud-status";
import { connectorSettingsUrl } from "@/lib/exomem-hosted/consent-view";
import { findExomemSessionByDigest } from "@/lib/exomem-hosted/db";
import { exomemCheckoutPriceId } from "@/lib/exomem-hosted/paddle-config";
import { marketplaceReviewerAccessEnabled } from "@/lib/exomem-hosted/reviewer-access";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import { EXOMEM_SESSION_COOKIE } from "@/lib/exomem-hosted/sessions";
import { statusPageUrl } from "../_journey/status-page";
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
  const [account, status, billing] = await Promise.all([
    loadExomemAccountView(session),
    getOwnerCloudStatus(session.tenantId),
    ownerBillingSummary(session.userId, session.tenantId),
  ]);
  const screen = setupScreen(account.step, status.state);
  if (!screen) return null;
  return {
    screen,
    email: account.email,
    tenantId: session.tenantId,
    keptUntil: account.keptUntil,
    supportReference: account.supportReference,
    mcpAddress: mcpAddress(),
    // Reconnection returns to client settings, while initial installation can use a public listing.
    settings: {
      claude: connectorSettingsUrl("claude", false).value,
      openai: connectorSettingsUrl("openai", false).value,
    },
    listings: { openai: CLIENT_PLATFORM_LISTING_URLS.openai },
    reviewerEnabled: marketplaceReviewerAccessEnabled(),
    priceId: exomemCheckoutPriceId(),
    friendOffer: account.plan.friendPrice,
    exportOffered: cloudExportsEnabled(),
    checkoutAvailable: billing.checkoutAvailable,
    paidPlan: account.plan.source === "paddle",
  };
}

/** The web journey after sign-in: subscribe, then add Exomem to an assistant. */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const cookieStore = await cookies();
  const facts = await setupFacts(cookieStore.get(EXOMEM_SESSION_COOKIE)?.value);
  if (!facts) redirect("/exomem/sign-in");
  const returned = (await searchParams)._ptxn;
  if (typeof returned === "string") facts.returnedTransactionId = returned;
  return <SetupClient facts={facts} statusPageUrl={statusPageUrl()} />;
}
