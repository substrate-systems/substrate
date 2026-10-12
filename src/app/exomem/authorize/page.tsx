import type { Metadata } from "next";
import { cookies } from "next/headers";
import { loadExomemAccountView } from "@/lib/exomem-hosted/account-view";
import { displayNameVouched } from "@/lib/exomem-hosted/client-platforms";
import { loadConsentView } from "@/lib/exomem-hosted/consent-view";
import { findExomemSessionByDigest } from "@/lib/exomem-hosted/db";
import { known, unknown } from "@/lib/exomem-hosted/known";
import {
  EXOMEM_OAUTH_CONTINUITY_COOKIE,
  EXOMEM_OAUTH_FORM_NONCE_COOKIE,
  OAUTH_TRANSACTION_TTL_MS,
} from "@/lib/exomem-hosted/oauth-continuity";
import { exomemCheckoutPriceId } from "@/lib/exomem-hosted/paddle-config";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import { EXOMEM_SESSION_COOKIE } from "@/lib/exomem-hosted/sessions";
import { statusPageUrl } from "../_journey/status-page";
import AuthorizeClient, { type AccountFacts } from "./authorize-client";
import { consentScreen } from "./consent-screen";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Authorize Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

const NOT_SIGNED_IN: AccountFacts = {
  readOnlyUntil: unknown("not_signed_in"),
  keptUntil: unknown("not_signed_in"),
  supportReference: unknown("not_signed_in"),
  friendInviter: null,
};

// The consent view does not carry these yet (its fields say `not_computed`); the
// account view computes them from stored data for the same signed-in session.
async function accountFacts(sessionCookie: string | undefined): Promise<AccountFacts> {
  const digest = sessionCookie ? tokenDigest(sessionCookie) : null;
  if (!digest) return NOT_SIGNED_IN;
  try {
    const session = await findExomemSessionByDigest(digest);
    if (!session) return NOT_SIGNED_IN;
    const account = await loadExomemAccountView(session);
    return {
      readOnlyUntil: account.readOnlyUntil,
      keptUntil: account.keptUntil,
      supportReference: known(account.supportReference),
      friendInviter: account.plan.friendPrice.inviterName,
    };
  } catch {
    // A storage failure is a visible unknown, never a guessed date.
    return {
      readOnlyUntil: unknown("unavailable"),
      keptUntil: unknown("unavailable"),
      supportReference: unknown("unavailable"),
      friendInviter: null,
    };
  }
}

/** "10 minutes", from the request lifetime the server enforces. */
function requestLife(): string {
  return `${Math.round(OAUTH_TRANSACTION_TTL_MS / 60_000)} minutes`;
}

export default async function ExomemAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ confirmation?: string }>;
}) {
  const cookieStore = await cookies();
  const query = await searchParams;
  const sessionCookie = cookieStore.get(EXOMEM_SESSION_COOKIE)?.value;
  const view = await loadConsentView({
    confirmation: query.confirmation,
    transactionCookie: cookieStore.get(EXOMEM_OAUTH_CONTINUITY_COOKIE)?.value,
    formNonceCookie: cookieStore.get(EXOMEM_OAUTH_FORM_NONCE_COOKIE)?.value,
    sessionCookie,
  });
  const screen = consentScreen(view);
  if (view.step === "expired") {
    return (
      <AuthorizeClient
        screen={screen}
        request={null}
        expiredApp={view.app?.displayName ?? null}
        requestLife={requestLife()}
        statusPageUrl={null}
      />
    );
  }
  return (
    <AuthorizeClient
      screen={screen}
      request={{
        app: {
          displayName: view.app.displayName,
          vouched: displayNameVouched(view.app.displayNameSource),
          platform: view.app.platform,
          loopback: view.app.loopback,
          redirectHost: view.app.redirectHost,
        },
        scopes: view.scopes,
        email: view.signedInEmail,
        confirmation: view.confirmation,
        nonce: view.nonce,
        reviewerEnabled: view.reviewerEnabled,
        connectorSettingsUrl: view.connectorSettingsUrl.value,
        account: view.signedInEmail ? await accountFacts(sessionCookie) : NOT_SIGNED_IN,
        priceId: exomemCheckoutPriceId(),
      }}
      requestLife={requestLife()}
      statusPageUrl={statusPageUrl()}
    />
  );
}
