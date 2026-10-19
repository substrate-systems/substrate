"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Mark } from "@/components/exomem/Mark";
import { Modal } from "@/components/exomem/Modal";
import { RadioCard } from "@/components/exomem/RadioCard";
import { Collapse, Swap } from "@/components/exomem/Transitions";
import { HostedBrowserError, postPrivateJson } from "@/lib/exomem-hosted/hosted-browser";
import { formatMoney } from "@/lib/exomem/money";
import { storageReply, type CloudStorageOperation } from "@/lib/exomem/storage-contract";
import { openInlineTransactionCheckout } from "@/lib/paddle";
import { gigabytes } from "./home-format";
import styles from "./home-storage.module.css";

type Catalogue = {
  tenantBinding: string;
  packs: { quantity: number; addedBytes: number; targetBytes: number }[];
};

export function StorageDialog({
  email,
  onClose,
  onAccountLost,
}: {
  email: string;
  onClose: () => void;
  onAccountLost: () => void;
}) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [operation, setOperation] = useState<CloudStorageOperation | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [frameAttempt, setFrameAttempt] = useState(0);
  const [inspectAttempt, setInspectAttempt] = useState(0);
  const alive = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  const frameTarget = `exomem-storage-${id.replaceAll(":", "")}`;
  const recoveryId =
    operation?.state === "payment_required" ? operation.recoveryTransactionId : null;
  const phase = operation?.state ?? (catalogue ? "pick" : "loading");
  const pending = phase === "updating" || phase === "unknown" || phase === "paid";
  const operationId = operation?.id ?? null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = useCallback(
    (error: unknown) => {
      if (!alive.current) return;
      if (error instanceof HostedBrowserError && (error.status === 401 || error.status === 403)) {
        setOperation(null);
        setCatalogue(null);
        onAccountLost();
        return;
      }
      setMessage(
        error instanceof HostedBrowserError
          ? error.message
          : "We couldn’t check this change. Try again."
      );
    },
    [onAccountLost]
  );

  const request = useCallback(
    async (body: Record<string, unknown>) => {
      const result = storageReply.parse(await postPrivateJson("/api/exomem/storage", body));
      if (!alive.current) return null;
      if (result.ownerEmail !== undefined && result.ownerEmail !== email) {
        throw new HostedBrowserError(
          { code: "STORAGE_ACCOUNT_CHANGED", message: "The signed-in account changed." },
          403
        );
      }
      return result;
    },
    [email]
  );

  useEffect(() => {
    void request({ action: "inspect" })
      .then((result) => {
        if (!result) return;
        if (!result.tenantBinding || !result.packs)
          throw new Error("Storage catalogue response is incomplete");
        setCatalogue({
          tenantBinding: result.tenantBinding,
          packs: result.packs,
        });
        setOperation(result.operation);
        setMessage(null);
        const previous = result.packs.find(
          (pack) => pack.addedBytes === result.operation?.addedBytes
        )?.quantity;
        setQuantity(previous !== undefined ? previous : (result.packs[0]?.quantity ?? null));
      })
      .catch(fail);
  }, [request, fail, inspectAttempt]);

  const preview = useCallback(async () => {
    if (!catalogue || quantity === null) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await request({
        action: "preview",
        tenantBinding: catalogue.tenantBinding,
        quantity,
      });
      if (result) setOperation(result.operation);
    } catch (error) {
      fail(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [catalogue, quantity, request, fail]);

  useEffect(() => {
    if (!pending || !operationId || !catalogue) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request({
          action: "status",
          tenantBinding: catalogue.tenantBinding,
          operationId,
        });
        if (result && !cancelled) {
          setOperation(result.operation);
          setMessage(null);
        }
      } catch (error) {
        if (!cancelled) fail(error);
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pending, operationId, catalogue, request, fail]);

  useEffect(() => {
    if (!recoveryId) return;
    let current = true;
    let close: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (current) setMessage("Paddle’s form hasn’t loaded. Try opening it again.");
    }, 15_000);
    void openInlineTransactionCheckout({
      transactionId: recoveryId,
      customerEmail: email,
      frameTarget,
      isCurrent: () => current && alive.current,
      onEvent: (event) => {
        if (event.name === "checkout.loaded") {
          clearTimeout(timer);
          setMessage(null);
        }
        if (event.name === "checkout.completed") {
          clearTimeout(timer);
          void preview();
        }
        if (event.name === "checkout.error") {
          clearTimeout(timer);
          setMessage("Paddle’s form didn’t load. Try opening it again.");
        }
      },
    })
      .then((cleanup) => {
        if (current) {
          close = cleanup;
          if (!cleanup) setMessage("Paddle’s form didn’t load. Try opening it again.");
        } else cleanup?.();
      })
      .catch(fail);
    return () => {
      current = false;
      clearTimeout(timer);
      close?.();
    };
  }, [recoveryId, frameAttempt, email, frameTarget, preview, fail]);

  useEffect(() => {
    const heading = content.current?.closest("dialog")?.querySelector("h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [phase]);

  async function confirm() {
    if (!catalogue || !operation) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await request({
        action: "confirm",
        tenantBinding: catalogue.tenantBinding,
        operationId: operation.id,
      });
      if (result) setOperation(result.operation);
    } catch (error) {
      if (error instanceof HostedBrowserError && error.code === "STORAGE_CONFLICT")
        setOperation(null);
      fail(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function paymentMethod() {
    if (!catalogue || !operation) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await request({
        action: "payment-method",
        tenantBinding: catalogue.tenantBinding,
        operationId: operation.id,
      });
      if (result) {
        setOperation(result.operation);
        setFrameAttempt((value) => value + 1);
      }
    } catch (error) {
      fail(error);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const title =
    phase === "applied" ? "More storage added" : phase === "paid" ? "Making room" : "More storage";
  return (
    <Modal open onClose={onClose} title={title} width={420} phoneFullWidth placement="top">
      <div ref={content} className={styles.content}>
        <Swap k={phase} block>
          <div className={styles.content}>
            {phase === "loading" && (
              <>
                <p className={styles.text}>Checking your plan and storage…</p>
                {message && (
                  <Button onClick={() => setInspectAttempt((value) => value + 1)}>Try again</Button>
                )}
              </>
            )}
            {catalogue && (phase === "pick" || phase === "failed" || phase === "superseded") && (
              <>
                <p className={styles.text}>
                  {phase === "failed"
                    ? "The storage change did not go through. Check the price to try again."
                    : "Add space for notes and files to your plan. Check the price before you confirm."}
                </p>
                <fieldset className={styles.packs} disabled={busy}>
                  <legend className="sr-only">Extra storage</legend>
                  {catalogue.packs.map((pack) => (
                    <RadioCard
                      key={pack.quantity}
                      name={id}
                      value={String(pack.quantity)}
                      checked={quantity === pack.quantity}
                      onChange={() => setQuantity(pack.quantity)}
                      detail={`${gigabytes(pack.targetBytes)} GB in all`}
                    >
                      +{gigabytes(pack.addedBytes)} GB
                    </RadioCard>
                  ))}
                </fieldset>
                {quantity !== null ? (
                  <Button
                    variant="primary"
                    size="dialog"
                    working={busy}
                    onClick={() => void preview()}
                  >
                    {busy ? "Checking the price…" : "Check the price"}
                  </Button>
                ) : (
                  <p className={styles.text}>
                    No extra storage is available for this plan just now.
                  </p>
                )}
              </>
            )}
            {phase === "preview" && operation && (
              <>
                <p className={styles.text}>
                  Add {gigabytes(operation.addedBytes)} GB to your plan. Then{" "}
                  {formatMoney(operation.quote.recurring)} at each renewal.
                </p>
                <dl className={styles.totals}>
                  <div>
                    <dt>Tax</dt>
                    <dd>{formatMoney(operation.quote.tax, { ledger: true })}</dd>
                  </div>
                  <div>
                    <dt>Due now</dt>
                    <dd>{formatMoney(operation.quote.due, { ledger: true })}</dd>
                  </div>
                </dl>
                <Button
                  variant="primary"
                  size="dialog"
                  working={busy}
                  onClick={() => void confirm()}
                >
                  {busy
                    ? "Adding storage…"
                    : `Add ${gigabytes(operation.addedBytes)} GB · ${formatMoney(operation.quote.due)} now`}
                </Button>
                <Button variant="ghost" size="dialog" onClick={() => setOperation(null)}>
                  Choose another amount
                </Button>
              </>
            )}
            {(phase === "updating" || phase === "unknown") && (
              <>
                <Mark state="working" size={44} />
                <p className={styles.text}>
                  Checking the change with Paddle. Open this panel again if you leave before it
                  finishes.
                </p>
              </>
            )}
            {phase === "paid" && (
              <>
                <Mark state="working" size={44} />
                <p className={styles.text}>
                  Payment received. Your extra space is being added. You can close this while it
                  finishes.
                </p>
              </>
            )}
            {phase === "payment_required" && (
              <>
                <p className={styles.text}>
                  Your card was declined. The storage change did not go through. Check your payment
                  details, then try again.
                </p>
                {recoveryId && <div className={`${styles.frame} ${frameTarget}`} />}
                <Button
                  variant="primary"
                  size="page"
                  working={busy}
                  onClick={() => void paymentMethod()}
                >
                  {recoveryId ? "Open the payment form again" : "Check payment details"}
                </Button>
                {recoveryId && (
                  <Button onClick={() => void preview()} working={busy}>
                    Check the price again
                  </Button>
                )}
              </>
            )}
            {phase === "applied" && operation?.capacityBytes && (
              <>
                <p className={styles.text}>
                  You now have {gigabytes(operation.capacityBytes)} GB. Saving carries on. Paddle
                  sends the receipt.
                </p>
                <Button variant="primary" size="dialog" onClick={onClose}>
                  Done
                </Button>
              </>
            )}
          </div>
        </Swap>
        <Collapse open={message !== null}>
          <p className={styles.text} role="status">
            {message}
          </p>
        </Collapse>
        {phase !== "applied" && (
          <Button variant="ghost" size="dialog" onClick={onClose}>
            {pending || phase === "payment_required" ? "Close" : "Cancel"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
