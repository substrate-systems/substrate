import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PrivateShell } from "../private-shell";
import {
  EXOMEM_OAUTH_FORM_NONCE_COOKIE,
  EXOMEM_OAUTH_CONTINUITY_COOKIE,
} from "@/lib/exomem-hosted/oauth-continuity";
import { loadConsentView } from "@/lib/exomem-hosted/consent-view";
import type { ConsentStep } from "@/lib/exomem-hosted/consent-state";
import { EXOMEM_SESSION_COOKIE } from "@/lib/exomem-hosted/sessions";
import AuthorizeClient from "./authorize-client";

const CONNECT_COPY = {
  title: "Connect this app to Exomem",
  lede: "This app is asking to read and write your Exomem. Confirm below to connect it.",
};

const STEP_COPY: Record<ConsentStep, { title: string; lede: string }> = {
  "sign-in": {
    title: "Connect this app to Exomem",
    lede: "Sign in to connect this app to your Exomem. You will come straight back here.",
  },
  subscribe: {
    title: "Subscribe to finish setting up",
    lede: "Your Exomem is reserved. Subscribe to start it, and then connect this app here.",
  },
  connect: CONNECT_COPY,
  "connect-read-only": CONNECT_COPY,
  ended: {
    title: "Your subscription has ended",
    lede: "Your Exomem is read-only now, so this app cannot connect to it.",
  },
  paused: {
    title: "Your subscription is paused",
    lede: "This app can connect when you resume your subscription.",
  },
  suspended: {
    title: "This Exomem is suspended",
    lede: "This app cannot connect while your Exomem is suspended.",
  },
};

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Authorize Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ExomemAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ confirmation?: string }>;
}) {
  const cookieStore = await cookies();
  const query = await searchParams;
  const view = await loadConsentView({
    confirmation: query.confirmation,
    transactionCookie: cookieStore.get(EXOMEM_OAUTH_CONTINUITY_COOKIE)?.value,
    formNonceCookie: cookieStore.get(EXOMEM_OAUTH_FORM_NONCE_COOKIE)?.value,
    sessionCookie: cookieStore.get(EXOMEM_SESSION_COOKIE)?.value,
  });
  if (view.step === "expired") {
    return (
      <PrivateShell>
        <main className="mx-auto max-w-xl px-6 py-16">
          <h1 className="text-2xl font-semibold">This connection request has expired</h1>
          <p className="mt-3 text-neutral-600">Start again from the app you want to connect.</p>
        </main>
      </PrivateShell>
    );
  }
  const copy = STEP_COPY[view.step];
  return (
    <PrivateShell>
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-2xl font-semibold">{copy.title}</h1>
        <p className="mt-3 text-neutral-600">{copy.lede}</p>
        <dl className="mt-6 space-y-2 text-sm text-neutral-700">
          <div>
            <dt className="font-medium">Client</dt>
            <dd>
              {view.app.displayName}
              {view.app.displayNameSource === "client_metadata" &&
                " (the name this app gives itself)"}
            </dd>
          </div>
          {/* Only a platform name is vouched for by Exomem. Any other name could
              be chosen by anyone, so show where the authorization would go. */}
          {view.app.displayNameSource !== "platform" && (
            <div>
              <dt className="font-medium">Sends access to</dt>
              <dd>{view.app.loopback ? "this computer" : view.app.redirectHost}</dd>
            </div>
          )}
          <div>
            <dt className="font-medium">Requested access</dt>
            <dd>{view.scopes.join(", ")}</dd>
          </div>
        </dl>
        <AuthorizeClient
          confirmation={view.confirmation}
          nonce={view.nonce}
          step={view.step}
          cellStarting={view.cellStarting}
          reviewerEnabled={view.reviewerEnabled}
        />
      </main>
    </PrivateShell>
  );
}
