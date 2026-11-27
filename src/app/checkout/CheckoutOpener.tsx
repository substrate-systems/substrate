"use client";

import { useCallback, useEffect, useState } from "react";
import { PaddleTransactionOpener } from "@/components/PaddleTransactionOpener";

// Paddle.js loads in a few seconds even on a slow phone connection; past this the
// buyer is better served by a retry than by a line that says "opening".
const OPEN_DEADLINE_MS = 15_000;

type Stage = "opening" | "opened" | "failed";

/** The caller passes a validated transaction id; the retry link repeats it. */
export function CheckoutOpener({ transactionId }: { transactionId: string }) {
  const [stage, setStage] = useState<Stage>("opening");
  const handleOpened = useCallback(() => setStage("opened"), []);
  // A failure report never overrides an overlay that already opened.
  const handleFailure = useCallback(
    () => setStage((current) => (current === "opened" ? current : "failed")),
    []
  );

  useEffect(() => {
    const timer = window.setTimeout(
      () => setStage((current) => (current === "opening" ? "failed" : current)),
      OPEN_DEADLINE_MS
    );
    return () => window.clearTimeout(timer);
  }, []);

  const link = (label: string) => (
    // A full page load, not a client navigation: the opener reads _ptxn once per load.
    <a
      href={`/checkout?_ptxn=${transactionId}`}
      className="mt-6 inline-block text-sm font-light text-fg-secondary transition-colors duration-default hover:text-fg-primary"
    >
      {label}
    </a>
  );

  // The opened line says "opened", not "is open": the overlay may be closed and the page cannot tell.
  return (
    <>
      {stage === "failed" ? (
        <>
          <p role="alert" className="mt-3 text-body-lg font-light text-fg-secondary">
            The checkout did not open.
          </p>
          {link("Try again")}
        </>
      ) : stage === "opened" ? (
        <>
          <p role="status" className="mt-3 text-body-lg font-light text-fg-secondary">
            Your checkout opened.
          </p>
          {link("Open the checkout again")}
        </>
      ) : (
        <p role="status" className="mt-3 text-body-lg font-light text-fg-secondary">
          Opening your checkout…
        </p>
      )}
      <PaddleTransactionOpener onOpened={handleOpened} onFailure={handleFailure} />
    </>
  );
}
