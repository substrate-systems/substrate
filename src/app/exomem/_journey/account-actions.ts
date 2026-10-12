"use client";

import { useEffect, useState } from "react";
import {
  HostedBrowserError,
  postPrivateJson,
  settledCheckoutDestination,
} from "@/lib/exomem-hosted/hosted-browser";
import { usePaddle } from "@/lib/paddle";

const SETTLE_ATTEMPTS = 10;
const SETTLE_INTERVAL_MS = 2000;

// After the Paddle overlay reports a completed payment, ask the server to settle
// the checkout. It answers with the next page: the consent page while an OAuth
// request is live, otherwise Home. Paddle can take a few seconds to mark the
// transaction complete, so this retries. Null means "ask the server again by
// reloading": the payment webhook settled the account first, or the attempts ran
// out, and the server computes the next step from the account either way.
async function settleCheckout(transactionId: string): Promise<string | null> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
    let settledElsewhere = false;
    try {
      const destination = settledCheckoutDestination(
        await postPrivateJson("/api/exomem/billing/checkout", { transactionId })
      );
      if (destination) return destination;
    } catch (error) {
      // The checkout route refuses a transaction whose account already has its
      // provider customer, which is what the payment webhook records.
      settledElsewhere = error instanceof HostedBrowserError && error.status === 403;
    }
    await new Promise((resolve) => window.setTimeout(resolve, SETTLE_INTERVAL_MS));
    if (settledElsewhere) return null;
  }
  return null;
}

/**
 * Subscribe through Paddle's overlay, on this page: the same request Home's
 * Subscribe makes. `onSettled` gets the server's next page, or null to reload.
 */
export function useCheckout(onSettled: (destination: string | null) => void) {
  const { completed, openTransactionCheckout } = usePaddle("transaction");
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  // The overlay reported this page's payment as complete.
  const confirming = completed && transactionId !== null;

  async function subscribe() {
    if (opening || confirming) return;
    setOpening(true);
    setFailed(false);
    try {
      const response = await postPrivateJson("/api/exomem/billing/checkout", {});
      const checkoutUrl = typeof response.checkoutUrl === "string" ? response.checkoutUrl : "";
      const transaction = checkoutUrl ? new URL(checkoutUrl).searchParams.get("_ptxn") : null;
      if (!transaction) throw new Error("missing checkout transaction");
      setTransactionId(transaction);
      if (!(await openTransactionCheckout(transaction))) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  }

  useEffect(() => {
    if (!confirming || !transactionId) return;
    let active = true;
    void settleCheckout(transactionId).then((destination) => {
      if (active) onSettled(destination);
    });
    return () => {
      active = false;
    };
  }, [confirming, transactionId, onSettled]);

  return { subscribe, opening, confirming, failed };
}

/** Paddle's billing portal: fix a failed payment, resume a paused subscription. */
export async function openBillingPortal(): Promise<boolean> {
  try {
    const response = await postPrivateJson("/api/exomem/billing/portal", {});
    if (typeof response.portalUrl !== "string") return false;
    window.location.assign(response.portalUrl);
    return true;
  } catch {
    return false;
  }
}

/** Ends this browser's session, for "Switch account". */
export async function signOut(): Promise<boolean> {
  try {
    await postPrivateJson("/api/exomem/access/logout", {});
    return true;
  } catch {
    return false;
  }
}
