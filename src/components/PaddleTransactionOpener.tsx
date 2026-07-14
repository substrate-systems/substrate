"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postPrivateJson } from "@/lib/exomem-hosted/hosted-browser";
import { usePaddle } from "@/lib/paddle";

const PADDLE_TRANSACTION_ID = /^txn_[a-z0-9]{26}$/;
const PENDING_TRANSACTION_KEY = "exomem:paddle-return-transaction";

function retainPendingTransaction(transactionId: string): void {
  try {
    window.sessionStorage.setItem(PENDING_TRANSACTION_KEY, transactionId);
  } catch {
    // In-memory retry still works when browser storage is unavailable.
  }
}

function readPendingTransaction(): string | null {
  try {
    const candidate = window.sessionStorage.getItem(PENDING_TRANSACTION_KEY);
    if (candidate && PADDLE_TRANSACTION_ID.test(candidate)) return candidate;
    window.sessionStorage.removeItem(PENDING_TRANSACTION_KEY);
  } catch {
    // The URL candidate remains available in memory for this page load.
  }
  return null;
}

function clearPendingTransaction(): void {
  try {
    window.sessionStorage.removeItem(PENDING_TRANSACTION_KEY);
  } catch {
    // Nothing sensitive is exposed if cleanup storage is unavailable.
  }
}

function OpenPaddleTransaction({
  transactionId,
  onOpened,
  onFailure,
}: {
  transactionId: string;
  onOpened: () => void;
  onFailure?: () => void;
}) {
  const { ready, error, openTransactionCheckout } = usePaddle();
  const openedRef = useRef(false);

  useEffect(() => {
    if (error) onFailure?.();
  }, [error, onFailure]);

  useEffect(() => {
    if (!ready || openedRef.current) return;
    openedRef.current = true;
    void (async () => {
      const opened = await openTransactionCheckout(transactionId);
      opened ? onOpened() : onFailure?.();
    })();
  }, [ready, openTransactionCheckout, onFailure, onOpened, transactionId]);

  return null;
}

function returnedCheckoutMatches(
  response: Record<string, unknown>,
  transactionId: string
): boolean {
  if (response.success !== true || typeof response.checkoutUrl !== "string") return false;
  try {
    const checkout = new URL(response.checkoutUrl);
    const query = [...checkout.searchParams];
    return (
      checkout.protocol === "https:" &&
      !checkout.username &&
      !checkout.password &&
      !checkout.hash &&
      query.length === 1 &&
      query[0][0] === "_ptxn" &&
      query[0][1] === transactionId
    );
  } catch {
    return false;
  }
}

export function PaddleTransactionOpener({
  validationEndpoint,
}: {
  validationEndpoint?: string;
} = {}) {
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [validationFailed, setValidationFailed] = useState(false);
  const [paddleFailed, setPaddleFailed] = useState(false);
  const [validationAttempt, setValidationAttempt] = useState(0);
  const candidateRef = useRef<string | null | undefined>(undefined);
  const validationRef = useRef<Promise<Record<string, unknown>> | null>(null);

  useEffect(() => {
    if (candidateRef.current === undefined) {
      const location = new URL(window.location.href);
      const returned = location.searchParams.get("_ptxn");
      const returnedCandidate = returned && PADDLE_TRANSACTION_ID.test(returned) ? returned : null;
      const candidate = returnedCandidate ?? (validationEndpoint ? readPendingTransaction() : null);
      candidateRef.current = candidate;
      if (candidate && validationEndpoint) retainPendingTransaction(candidate);
      location.searchParams.delete("_ptxn");
      window.history.replaceState(
        window.history.state,
        "",
        `${location.pathname}${location.search}${location.hash}`
      );
    }
    const candidate = candidateRef.current;
    if (!candidate) return;
    if (!validationEndpoint) {
      setTransactionId(candidate);
      return;
    }

    let active = true;
    setValidationFailed(false);
    validationRef.current ??= postPrivateJson(validationEndpoint, {
      transactionId: candidate,
    });
    void validationRef.current
      .then((response) => {
        if (
          active &&
          response.success === true &&
          response.state === "settled" &&
          response.redirectUrl === "/exomem/home"
        ) {
          clearPendingTransaction();
          candidateRef.current = null;
          window.location.replace(response.redirectUrl);
          return;
        }
        if (active && returnedCheckoutMatches(response, candidate)) {
          setTransactionId(candidate);
          return;
        }
        if (active) setValidationFailed(true);
      })
      .catch(() => {
        if (active) setValidationFailed(true);
      });
    return () => {
      active = false;
    };
  }, [validationAttempt, validationEndpoint]);

  const handleCheckoutOpened = useCallback(() => {
    clearPendingTransaction();
    candidateRef.current = null;
  }, []);

  const handleCheckoutFailure = useCallback(() => {
    if (!validationEndpoint) return;
    setTransactionId(null);
    setPaddleFailed(true);
  }, [validationEndpoint]);

  function retryValidation(): void {
    if (paddleFailed) {
      window.location.reload();
      return;
    }
    validationRef.current = null;
    setValidationFailed(false);
    setValidationAttempt((attempt) => attempt + 1);
  }

  function dismissValidation(): void {
    clearPendingTransaction();
    candidateRef.current = null;
    validationRef.current = null;
    setValidationFailed(false);
    setPaddleFailed(false);
  }

  if (validationFailed || paddleFailed) {
    return (
      <section
        aria-live="polite"
        className="mb-4 rounded-2xl border border-amber-300/40 bg-amber-100/10 p-4 text-sm text-slate-100"
      >
        <p>
          {paddleFailed
            ? "Checkout couldn't open. Reload it when you're ready to try again."
            : "We couldn't reconnect to checkout. Your Exomem account is safe."}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={retryValidation}
            className="rounded-full bg-white px-4 py-2 font-medium text-slate-950"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={dismissValidation}
            className="rounded-full border border-white/30 px-4 py-2 font-medium text-white"
          >
            Not now
          </button>
        </div>
      </section>
    );
  }

  if (!transactionId) return null;
  return (
    <OpenPaddleTransaction
      transactionId={transactionId}
      onOpened={handleCheckoutOpened}
      onFailure={handleCheckoutFailure}
    />
  );
}
