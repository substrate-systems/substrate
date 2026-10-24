"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { formatMoney, isExomemMoney, type ExomemMoney } from "@/lib/exomem/money";
import { PENDING_TRANSACTION_KEY } from "@/components/PaddleTransactionOpener";
import {
  getPrivateJson,
  postPrivateJson,
  HostedBrowserError,
} from "@/lib/exomem-hosted/hosted-browser";
import { openInlineTransactionCheckout } from "@/lib/paddle";
import { CheckoutEventNames } from "@paddle/paddle-js";
import { Button } from "./Button";
import { FlowField } from "./FlowField";
import { Mark } from "./Mark";
import { Wordmark } from "./Wordmark";
import { ThemeToggle } from "./ThemeToggle";
import { Collapse, Crossfade, Skeleton, Swap } from "./Transitions";
import {
  formatCheckoutMoney,
  reduceCheckoutEvent,
  type InlineCheckoutState,
} from "./inline-checkout-state";
import styles from "./CheckoutInline.module.css";

const LOAD_DEADLINE_MS = 15_000;
const BANK_WAIT_MS = 8_000;
const SETUP_WAIT_MS = 30_000;
const COMPACT_QUERY = "(max-width: 640px), (max-height: 480px)";

function forgetReturnedTransaction(transactionId: string | undefined) {
  try {
    // A newer return must survive dismissal of this checkout.
    if (window.sessionStorage.getItem(PENDING_TRANSACTION_KEY) === transactionId)
      window.sessionStorage.removeItem(PENDING_TRANSACTION_KEY);
  } catch {
    /* URL recovery still works when browser storage is unavailable. */
  }
}

function subscribeCompact(notify: () => void) {
  const media = window.matchMedia(COMPACT_QUERY);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}

/** The owner transaction stays mounted once, while provider and cell states change around it. */
export function CheckoutInline({
  email,
  tenantId,
  inviter,
  onReady,
  readyEmailAvailable = false,
  paidOnArrival = false,
  returnedTransactionId,
  exportOffered,
}: {
  email: string;
  tenantId: string | null;
  inviter?: string | null;
  onReady: () => void;
  /** Whether Home offers an export: the export flag (design.md (s)). */
  exportOffered: boolean;
  readyEmailAvailable?: boolean;
  paidOnArrival?: boolean;
  returnedTransactionId?: string;
}) {
  const id = useId();
  const frameTarget = `exomem-checkout-${id.replaceAll(":", "")}`;
  const [checkout, setCheckout] = useState<InlineCheckoutState>({
    transactionId: null,
    phase: paidOnArrival ? "confirming" : "loading",
    data: null,
  });
  const [setupSlow, setSetupSlow] = useState(false);
  const [returnFailed, setReturnFailed] = useState(false);
  const [sessionRejected, setSessionRejected] = useState(false);
  const accountRejected = !tenantId || sessionRejected;
  const [nextPayment, setNextPayment] = useState<string | null>(null);
  const [accountPrice, setAccountPrice] = useState<ExomemMoney | null>(null);
  const compact = useSyncExternalStore(
    subscribeCompact,
    () => window.matchMedia(COMPACT_QUERY).matches,
    () => false
  );
  const readyButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const paidPanel = useRef<HTMLDivElement>(null);
  const phase = checkout.phase;
  const paid = phase === "confirming" || phase === "ready_to_connect";
  const paying = phase === "paying" || phase === "slow";
  useEffect(() => {
    if (accountRejected || !tenantId) return;
    let current = true;
    void getPrivateJson(`/api/exomem/account?tenantId=${encodeURIComponent(tenantId)}`)
      .then((result) => {
        const account = result.account as
          | { nextPaymentAt?: { value?: unknown }; nextPaymentAmount?: { value?: unknown } }
          | undefined;
        if (!current) return;
        const date = account?.nextPaymentAt?.value;
        if (typeof date === "string" && Number.isFinite(Date.parse(date))) setNextPayment(date);
        const amount = account?.nextPaymentAmount?.value;
        if (isExomemMoney(amount)) setAccountPrice(amount);
      })
      .catch((error) => {
        if (
          current &&
          error instanceof HostedBrowserError &&
          (error.status === 401 || error.status === 403)
        )
          setSessionRejected(true);
        /* Unknown facts stay unreported. */
      });
    return () => {
      current = false;
    };
  }, [tenantId, paid, accountRejected]);

  useEffect(() => {
    if (paidOnArrival || accountRejected || !tenantId) return;
    let current = true;
    let expired = false;
    let validated = false;
    let close: (() => void) | null = null;
    const deadline = window.setTimeout(() => {
      expired = true;
      close?.();
      // A returned payment may already be with Paddle, so a check that runs out of time
      // says so instead of "Nothing was charged."
      if (returnedTransactionId && !validated) setReturnFailed(true);
      setCheckout((state) =>
        state.phase === "loading" ? { ...state, phase: "unavailable", data: null } : state
      );
    }, LOAD_DEADLINE_MS);
    void (async () => {
      try {
        const result = await postPrivateJson(
          "/api/exomem/billing/checkout",
          returnedTransactionId ? { tenantId, transactionId: returnedTransactionId } : { tenantId }
        );
        validated = true;
        // A late answer still counts when it says the returned payment settled.
        const settled = result.state === "settled" && !!returnedTransactionId;
        if (!current || (expired && !settled)) return;
        if (returnedTransactionId) {
          forgetReturnedTransaction(returnedTransactionId);
          const location = new URL(window.location.href);
          location.searchParams.delete("_ptxn");
          window.history.replaceState(
            window.history.state,
            "",
            location.pathname + location.search + location.hash
          );
        }
        if (settled && returnedTransactionId) {
          window.clearTimeout(deadline);
          setReturnFailed(false);
          setCheckout({ transactionId: returnedTransactionId, phase: "confirming", data: null });
          return;
        }
        const transactionId =
          typeof result.checkoutUrl === "string"
            ? new URL(result.checkoutUrl).searchParams.get("_ptxn")
            : null;
        if (!transactionId) throw new Error("Checkout transaction unavailable");
        if (!current || expired) return;
        setCheckout({ transactionId, phase: "loading", data: null });
        close = await openInlineTransactionCheckout({
          transactionId,
          customerEmail: email,
          frameTarget,
          isCurrent: () => current && !expired,
          onEvent: (event) => {
            if (
              event.name === CheckoutEventNames.CHECKOUT_LOADED ||
              event.name === CheckoutEventNames.CHECKOUT_COMPLETED
            )
              window.clearTimeout(deadline);
            setCheckout((state) => reduceCheckoutEvent(state, event));
          },
        });
        if (!current) close?.();
        else if (!close && !expired)
          setCheckout((state) => ({ ...state, phase: "unavailable", data: null }));
      } catch (error) {
        if (current && !expired) {
          if (
            error instanceof HostedBrowserError &&
            (error.status === 401 || error.status === 403)
          ) {
            setSessionRejected(true);
            return;
          }
          setReturnFailed(!!returnedTransactionId && !validated);
          setCheckout((state) => ({ ...state, phase: "unavailable", data: null }));
        }
      }
    })();
    return () => {
      current = false;
      window.clearTimeout(deadline);
      close?.();
    };
  }, [email, tenantId, frameTarget, paidOnArrival, returnedTransactionId, accountRejected]);

  useEffect(() => {
    if (phase !== "paying") return;
    const timer = window.setTimeout(
      () =>
        setCheckout((state) => (state.phase === "paying" ? { ...state, phase: "slow" } : state)),
      BANK_WAIT_MS
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== "confirming" || accountRejected || !tenantId) return;
    let current = true;
    let timer = 0;
    const slow = window.setTimeout(() => setSetupSlow(true), SETUP_WAIT_MS);
    const transactionId = checkout.transactionId;
    const observe = async () => {
      try {
        // The owner-bound settlement validates the payment; readiness still comes from the cell controller.
        const settled = transactionId
          ? await postPrivateJson("/api/exomem/billing/checkout", { tenantId, transactionId })
          : null;
        const status =
          !transactionId || settled?.state === "settled"
            ? await getPrivateJson(`/api/exomem/status?tenantId=${encodeURIComponent(tenantId)}`)
            : null;
        if (!current) return;
        if ((status?.status as { state?: unknown } | undefined)?.state === "ready") {
          const account = await getPrivateJson(
            `/api/exomem/account?tenantId=${encodeURIComponent(tenantId)}`
          );
          const date = (account?.account as { nextPaymentAt?: { value?: unknown } } | undefined)
            ?.nextPaymentAt?.value;
          if (!current) return;
          if (typeof date === "string" && Number.isFinite(Date.parse(date))) setNextPayment(date);
          setCheckout((state) => ({ ...state, phase: "ready_to_connect" }));
          return;
        }
      } catch (error) {
        if (
          current &&
          error instanceof HostedBrowserError &&
          (error.status === 401 || error.status === 403)
        ) {
          setSessionRejected(true);
          return;
        }
        // The controller and payment webhook converge independently; a later observation may succeed.
      }
      if (current) timer = window.setTimeout(observe, 2000);
    };
    void observe();
    return () => {
      current = false;
      window.clearTimeout(timer);
      window.clearTimeout(slow);
    };
  }, [phase, checkout.transactionId, tenantId, accountRejected]);

  useEffect(() => {
    if (phase === "unavailable" || accountRejected)
      retryButton.current?.focus({ preventScroll: true });
    if (phase === "ready_to_connect") readyButton.current?.focus({ preventScroll: true });
    if (paid && compact)
      paidPanel.current?.scrollIntoView({
        block: "nearest",
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }, [phase, paid, compact, accountRejected]);

  const data = checkout.data;
  const money = (amount: number | undefined, ledger = false) =>
    data && amount !== undefined ? formatCheckoutMoney(amount, data.currency_code, ledger) : null;
  const cycle = data?.items.find((item) => item.billing_cycle)?.billing_cycle;
  const cadence = cycle
    ? cycle.frequency === 1
      ? `a ${cycle.interval}`
      : `every ${cycle.frequency} ${cycle.interval}s`
    : null;
  const recurring =
    money(data?.recurring_totals?.total) ?? (accountPrice ? formatMoney(accountPrice) : null);
  // Paddle's form loading, or not loaded at all, draws the amount's place (Checkout-Inline:
  // a still bar once it failed); an amount the page otherwise never got is said so.
  const unreported = (width: number, height = 12) =>
    phase === "loading" || phase === "unavailable" ? (
      <Skeleton width={width} height={height} still={phase === "unavailable"} />
    ) : (
      "Not reported"
    );
  const total = money(data?.totals.total);
  const renewal = nextPayment
    ? new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }).format(new Date(nextPayment))
    : null;
  const status = accountRejected
    ? "We couldn’t check this checkout with your current sign-in. Sign in again to continue."
    : phase === "loading"
      ? "Getting the price from Paddle."
      : phase === "unavailable"
        ? returnFailed
          ? "We couldn’t check this checkout. Your payment may have reached Paddle."
          : "Prices appear when Paddle’s form loads."
        : phase === "failed"
          ? "Your payment didn’t finish. Check Paddle’s form and try again."
          : phase === "slow"
            ? "Still waiting for your bank. This can take a minute. Keep this tab open."
            : paying
              ? `Paying${total ? ` ${total}` : ""} with Paddle. Keep this tab open.`
              : phase === "ready_to_connect"
                ? "Paid. Your Exomem is ready."
                : paid
                  ? setupSlow && readyEmailAvailable
                    ? `We’ll email ${email} when it’s ready.`
                    : setupSlow
                      ? "Still switching on your Exomem. You can return here later."
                      : "Paid. Switching on your Exomem."
                  : recurring && cadence
                    ? `Then ${recurring} ${cadence}. ${renewal ? `Next on ${renewal}. ` : ""}Cancel any time.`
                    : "Paddle shows your next payment before you pay.";
  const activity = useMemo(
    () =>
      paying
        ? {
            kind: "work" as const,
            on: true,
            amber: true,
            clear: `[data-checkout-panel="${frameTarget}"]`,
            toward: `[data-checkout-panel="${frameTarget}"]`,
          }
        : phase === "ready_to_connect"
          ? { kind: "connect" as const }
          : undefined,
    [paying, phase, frameTarget]
  );
  const progressStep = phase === "ready_to_connect" ? 5 : paid ? 3 : paying ? 1 : 0;
  const markState =
    phase === "failed"
      ? "failed"
      : phase === "ready_to_connect"
        ? "done"
        : paying || paid
          ? "progress"
          : "rest";

  return (
    <main className={`brand-exomem ${styles.page}`} data-alive-surface>
      <FlowField kind={paying || paid ? "hold" : "quiet"} activity={activity} checkout />
      <header className={styles.header}>
        <a
          href="/exomem/home"
          className={styles.wordmark}
          aria-label="Exomem home"
          data-graph-clear
        >
          <Wordmark />
        </a>
        <span className={styles.email} data-graph-clear>
          {email}
        </span>
      </header>
      {/* As on every flow page, the theme control sits at the page gutter (Journey board). */}
      <span className={styles.theme} data-graph-header>
        <ThemeToggle align="end" />
      </span>
      <section className={styles.content}>
        <div className={styles.heading}>
          <h1>
            <Swap k={paid ? "subscribed" : "subscribe"}>
              {paid ? "You’re subscribed" : "Subscribe to finish setting up"}
            </Swap>
          </h1>
          <p>
            {inviter
              ? `${inviter}’s friend price is applied below. Paddle takes the payment. Cancel any time.`
              : "Exomem, billed monthly by Paddle. Cancel any time. Next, you add it to your assistant."}
          </p>
        </div>
        <div
          className={styles.panel}
          data-checkout-panel={frameTarget}
          data-paid={paid || undefined}
        >
          <div className={styles.summary}>
            <div className={styles.product}>
              <span className={styles.tile}>
                <Mark size={27} state={markState} steps={5} step={progressStep} />
              </span>
              <span>
                Exomem
                {/* Exomem is a monthly subscription (the Terms), as the lede says. */}
                <span className={styles.productNote}>
                  monthly · one knowledge base for every assistant
                </span>
              </span>
            </div>
            <div className={styles.price}>
              {inviter ? <span className={styles.friend}>{inviter}’s friend price</span> : null}
              <div>
                <span className={styles.priceValue}>{recurring ?? unreported(150, 36)}</span>
                <span className={styles.cadence}>
                  {/* Paddle's own cycle wins once it reports one; beside the amount's
                      placeholder the board says what the plan is: monthly. */}
                  {cadence ??
                    (accountPrice
                      ? "next payment"
                      : phase === "loading" || phase === "unavailable"
                        ? "a month"
                        : null)}
                </span>
              </div>
              <span className={styles.priceNote}>Cancel any time.</span>
            </div>
            {/* The price-first summary draws no plan row: the price above is the plan. */}
            <dl className={styles.ledger}>
              {data && data.totals.discount > 0 ? (
                <div>
                  <dt>{inviter ? "Friend price" : "Discount"}</dt>
                  <dd>−{money(data.totals.discount, true)}</dd>
                </div>
              ) : null}
              <div>
                <dt>
                  Tax <span>{data ? "included in total" : ""}</span>
                </dt>
                <dd>{money(data?.totals.tax, true) ?? unreported(68)}</dd>
              </div>
              <div className={styles.due}>
                <dt>
                  <Swap k={paid ? "paid" : paying ? "paying" : "due"}>
                    {paid ? "Paid today" : paying ? "Paying now" : "Due today"}
                  </Swap>
                </dt>
                <dd>
                  {money(
                    paid ? data?.totals.total : (data?.totals.balance ?? data?.totals.total),
                    true
                  ) ?? unreported(104, 20)}
                </dd>
              </div>
            </dl>
            <div className={styles.statusLine}>
              {paying || paid ? (
                <Mark size={22} state={markState} steps={5} step={progressStep} />
              ) : null}
              <span>
                <Swap k={phase + String(accountRejected) + String(setupSlow) + String(renewal)}>
                  {status}
                </Swap>
              </span>
            </div>
            <div className={styles.gets}>
              <ul>
                <li>One knowledge base for every assistant you connect</li>
                <li>Keeps what changed, why, and what replaced it</li>
                {/* No export promise while Home offers none (design.md (s)). */}
                <li>
                  {exportOffered
                    ? "Plain Markdown you own. Export it any time."
                    : "Plain Markdown you own."}
                </li>
              </ul>
              {phase === "ready_to_connect" ? null : (
                <p className={styles.next}>Next: add Exomem to your assistant</p>
              )}
            </div>
          </div>
          <div className={styles.paymentArea}>
            <Crossfade
              show={
                accountRejected
                  ? "unavailable"
                  : paid
                    ? "paid"
                    : phase === "unavailable"
                      ? "unavailable"
                      : phase === "loading"
                        ? "loading"
                        : "form"
              }
              panes={{
                form: (
                  <Collapse open={!compact || !paid}>
                    <div className={styles.form}>
                      <div className={frameTarget} />
                      <Collapse open={phase === "failed"}>
                        <p className={styles.failure}>
                          Your payment didn’t finish. Try another card or payment method.
                        </p>
                      </Collapse>
                      {paying ? <p className={styles.phoneStatus}>{status}</p> : null}
                    </div>
                  </Collapse>
                ),
                loading: (
                  <div className={styles.loading} aria-hidden>
                    <Skeleton height={64} />
                    <Skeleton height={64} />
                    <Skeleton height={120} />
                  </div>
                ),
                unavailable: (
                  <div className={styles.unavailable}>
                    <h2>
                      {accountRejected
                        ? "Sign in again to continue"
                        : returnFailed
                          ? "We couldn’t check this checkout"
                          : "Paddle’s form didn’t load"}
                    </h2>
                    <p>
                      {accountRejected
                        ? "This does not change any payment Paddle received. Sign in to the account that opened this checkout."
                        : returnFailed
                          ? "Your payment may have reached Paddle. Try again, or check your account."
                          : returnedTransactionId
                            ? "A content blocker or a weak connection can stop it."
                            : "A content blocker or a weak connection can stop it. Nothing was charged."}
                    </p>
                    <Button
                      ref={retryButton}
                      size="page"
                      onClick={() =>
                        accountRejected
                          ? window.location.assign("/exomem/sign-in")
                          : window.location.reload()
                      }
                    >
                      {accountRejected ? "Sign in again" : "Try again"}
                    </Button>
                    {returnFailed && !accountRejected ? (
                      <Button
                        variant="ghost"
                        size="page"
                        onClick={() => {
                          forgetReturnedTransaction(returnedTransactionId);
                          window.location.replace("/exomem/home");
                        }}
                      >
                        Not now
                      </Button>
                    ) : null}
                  </div>
                ),
                paid: (
                  <div className={styles.paid} ref={paidPanel}>
                    <Mark size={60} state={markState} steps={5} step={progressStep} />
                    <h2>
                      <Swap k={phase}>
                        {phase === "ready_to_connect"
                          ? "Your Exomem is ready"
                          : "Paid. Almost ready."}
                      </Swap>
                    </h2>
                    {phase === "confirming" ? (
                      <ol className={styles.readySteps}>
                        <li>
                          <span className={styles.stepDone} aria-hidden="true">
                            ✓
                          </span>
                          Payment received by Paddle
                        </li>
                        <li>
                          <span className={styles.stepNow} aria-hidden="true" />
                          Switching on your Exomem
                        </li>
                        <li className={styles.stepNext}>
                          <span className={styles.stepRing} aria-hidden="true" />
                          Then you add it to your assistant
                        </li>
                      </ol>
                    ) : (
                      <p>Now add it to the assistant you use.</p>
                    )}
                    {/* The board keeps the button's place and shows it only once the Exomem is ready. */}
                    <div
                      className={
                        phase === "ready_to_connect"
                          ? styles.readySlot
                          : `${styles.readySlot} ${styles.notYet}`
                      }
                    >
                      <Button
                        ref={readyButton}
                        variant="primary"
                        size="page"
                        disabled={phase !== "ready_to_connect"}
                        onClick={onReady}
                      >
                        Add it to your assistant →
                      </Button>
                    </div>
                  </div>
                ),
              }}
            />
          </div>
        </div>
        <a
          href="/exomem/home"
          className={styles.home}
          onClick={() => forgetReturnedTransaction(returnedTransactionId)}
        >
          Go to Home
        </a>
      </section>
      <p className={styles.announcement} role="status" aria-live="polite">
        {status}
      </p>
    </main>
  );
}
