"use client";

import { useEffect, useState } from "react";
import {
  CheckoutEventNames,
  initializePaddle,
  type Environments,
  type Paddle,
} from "@paddle/paddle-js";
import { AnalyticsEvent, capture, currentDistinctId } from "@/lib/analytics";

type CompletionListener = () => void;

/** What a checkout is for, carried on every event in the funnel. */
export type CheckoutProduct = "supporter" | "hosted_backup" | "transaction";

/**
 * Where in the checkout path a failure happened. One event name with a stage
 * beats three event names, because "how many checkouts failed for any reason"
 * stays a single query.
 */
type FailureStage = "sdk_init" | "missing_price_id" | "open";

function trackCheckoutFailure(
  product: CheckoutProduct,
  stage: FailureStage,
  detail?: Record<string, unknown>
): void {
  capture(AnalyticsEvent.CheckoutFailed, { product, stage, ...detail });
}

/**
 * Carries the visitor's anonymous identity into Paddle so the webhook can
 * attribute a purchase back to the browsing session that produced it.
 *
 * Returns undefined rather than a partial object when the SDK is blocked, so
 * Paddle receives no key at all instead of an empty one.
 */
function checkoutCustomData(): { ph_distinct_id: string } | undefined {
  const id = currentDistinctId();
  return id ? { ph_distinct_id: id } : undefined;
}

let paddlePromise: Promise<Paddle | null> | null = null;
const completionListeners = new Set<CompletionListener>();

function resolveEnvironment(): Environments {
  const raw = process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT;
  if (raw === "sandbox" || raw === "production") return raw;
  return "production";
}

function loadPaddle(): Promise<Paddle | null> {
  if (paddlePromise) return paddlePromise;

  const token = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN;
  if (!token) {
    paddlePromise = Promise.resolve(null);
    console.error("[paddle] NEXT_PUBLIC_PADDLE_CLIENT_TOKEN is not set");
    return paddlePromise;
  }

  paddlePromise = initializePaddle({
    token,
    environment: resolveEnvironment(),
    eventCallback: (event) => {
      if (event.name === CheckoutEventNames.CHECKOUT_COMPLETED) {
        // Paddle's own callback is the only completion signal the browser gets;
        // the authoritative record is the webhook, captured server-side.
        capture(AnalyticsEvent.CheckoutCompleted, {
          transaction_id: event.data?.transaction_id ?? null,
        });
        completionListeners.forEach((fn) => {
          try {
            fn();
          } catch (err) {
            console.error("[paddle] completion listener threw", err);
          }
        });
      }
    },
  })
    .then((instance) => instance ?? null)
    .catch((err) => {
      console.error("[paddle] failed to initialize", err);
      return null;
    });

  return paddlePromise;
}

export type HostedBackupCadence = "monthly" | "yearly";

export type UsePaddleResult = {
  ready: boolean;
  error: string | null;
  completed: boolean;
  openSupporterCheckout: () => Promise<void>;
  openHostedBackupCheckout: (cadence: HostedBackupCadence) => Promise<void>;
  openTransactionCheckout: (transactionId: string) => Promise<boolean>;
};

const UNAVAILABLE_MESSAGE = "Checkout is unavailable right now. Please try again later.";

async function openCheckoutWith(
  product: CheckoutProduct,
  open: (paddle: Paddle) => void
): Promise<boolean> {
  const paddle = await loadPaddle();
  if (!paddle) {
    // The SDK never initialised — usually a missing token or a blocked script.
    // Distinguishable from an open() failure, and far more likely to be systemic.
    trackCheckoutFailure(product, "sdk_init");
    alert(UNAVAILABLE_MESSAGE);
    return false;
  }
  try {
    open(paddle);
    return true;
  } catch (err) {
    console.error("[paddle] failed to open checkout", err);
    trackCheckoutFailure(product, "open");
    alert(UNAVAILABLE_MESSAGE);
    return false;
  }
}

export function usePaddle(): UsePaddleResult {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadPaddle().then((instance) => {
      if (cancelled) return;
      if (instance) {
        setReady(true);
      } else {
        setError("Checkout is unavailable right now.");
      }
    });

    const onComplete = () => setCompleted(true);
    completionListeners.add(onComplete);
    return () => {
      cancelled = true;
      completionListeners.delete(onComplete);
    };
  }, []);

  async function openSupporterCheckout(): Promise<void> {
    capture(AnalyticsEvent.CheckoutStarted, { product: "supporter" });
    const priceId = process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER;
    if (!priceId) {
      console.error("[paddle] NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER is not set");
      trackCheckoutFailure("supporter", "missing_price_id");
      alert(UNAVAILABLE_MESSAGE);
      return;
    }
    await openCheckoutWith("supporter", (paddle) => {
      paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        customData: checkoutCustomData(),
      });
    });
  }

  async function openHostedBackupCheckout(cadence: HostedBackupCadence): Promise<void> {
    capture(AnalyticsEvent.CheckoutStarted, { product: "hosted_backup", cadence });
    const envName =
      cadence === "yearly"
        ? "NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY"
        : "NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY";
    const priceId =
      cadence === "yearly"
        ? process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY
        : process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY;
    if (!priceId) {
      console.error(`[paddle] ${envName} is not set`);
      trackCheckoutFailure("hosted_backup", "missing_price_id", { cadence });
      alert(UNAVAILABLE_MESSAGE);
      return;
    }
    await openCheckoutWith("hosted_backup", (paddle) => {
      paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        customData: checkoutCustomData(),
      });
    });
  }

  async function openTransactionCheckout(transactionId: string): Promise<boolean> {
    capture(AnalyticsEvent.CheckoutStarted, { product: "transaction" });
    return openCheckoutWith("transaction", (paddle) => {
      // A transaction checkout resumes an existing Paddle transaction, which
      // already carries its own customData from when it was created.
      paddle.Checkout.open({ transactionId });
    });
  }

  return {
    ready,
    error,
    completed,
    openSupporterCheckout,
    openHostedBackupCheckout,
    openTransactionCheckout,
  };
}
