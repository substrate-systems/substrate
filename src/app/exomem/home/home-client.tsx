"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Notice } from "@/components/exomem/Notice";
import phone from "@/components/exomem/phone.module.css";
import { usePaddlePricePreview } from "@/lib/paddle";
import {
  type PaddleTransactionFailure,
  PaddleTransactionOpener,
} from "@/components/PaddleTransactionOpener";
import {
  billingDestination,
  disconnectApp,
  type HomeAccount,
  type HomeActivity,
  type HomeApp,
  type HomeBilling,
  type HomeLevels,
  NOT_RELEASED,
  readAccount,
  readActivity,
  readApps,
  readLevels,
  readStatus,
  requestDeletion,
  requestExportLink,
  SignedOutError,
  signOut,
  startExport,
  type LevelContext,
  type LevelKey,
  type StatusRead,
  writeLevel,
} from "./home-api";
import { PriceCard } from "../_journey/parts";
import { ConnectedApps } from "./home-apps";
import { PlanAndAccount, YourData } from "./home-account";
import { HomeHeader, HomeWeb, StatusBlock } from "./home-chrome";
import { DeleteDialog, type DeleteStep, SignedOutDialog } from "./home-dialogs";
import type { Clock } from "./home-format";
import { InvolvementLevels } from "./home-levels";
import { createSingleFlight, type Lifecycle, nextStatusPollDelayMs } from "./home-state";
import {
  type AccountRead,
  activityFacts,
  activityUnavailableText,
  banner,
  deletionLinkMinutes,
  exportRefusalText,
  exportView,
  firstNoteLine,
  homeMode,
  isLive,
  levelRefusalText,
  levelsView,
  liveLine,
  notices,
  planView,
  showsUsualPrice,
  statusCopy,
  storageView,
  subscribeView,
} from "./home-view";
import styles from "./home.module.css";

/** Home reads activity, and the status poll, this often while the tab is visible. */
const REFRESH_MS = 30_000;
/** A pending download link is asked for again this many times, this far apart. */
const LINK_ATTEMPTS = 3;
const LINK_RETRY_MS = 2_000;

const LOADING: Lifecycle = { state: "loading", code: "TENANT_PREPARING", retryable: true };
// A status read that fails is shown as trouble, never as ready.
const UNREACHABLE: Lifecycle = { state: "degraded", code: "CELL_UNAVAILABLE", retryable: true };

function visibleNow(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function goToSignIn() {
  window.location.replace("/exomem/sign-in");
}

export default function HomeClient({
  priceId,
  exportOffered,
}: {
  priceId: string | null;
  /** Whether Home offers an export: the export flag (design.md deviation (s)). */
  exportOffered: boolean;
}) {
  const [status, setStatus] = useState<StatusRead | null>(null);
  const [account, setAccount] = useState<HomeAccount | null>(null);
  const [accountRead, setAccountRead] = useState<AccountRead>("loading");
  const [billing, setBilling] = useState<HomeBilling | null>(null);
  const [apps, setApps] = useState<HomeApp[] | null>(null);
  const [appsFailed, setAppsFailed] = useState(false);
  const [levels, setLevels] = useState<HomeLevels | typeof NOT_RELEASED | null>(null);
  const [activity, setActivity] = useState<HomeActivity | typeof NOT_RELEASED | null>(null);
  // The browser's time when the activity arrived: ages are read on the cell's clock.
  const [activityAt, setActivityAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const [disconnected, setDisconnected] = useState<ReadonlySet<string>>(new Set());
  const [levelPending, setLevelPending] = useState<LevelContext | null>(null);
  const [levelMessage, setLevelMessage] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [deleteStep, setDeleteStep] = useState<DeleteStep | null>(null);
  const [deleteMinutes, setDeleteMinutes] = useState<number | null>(null);
  const [referenceCopied, setReferenceCopied] = useState(false);

  const mounted = useRef(true);
  const statusFlight = useRef(createSingleFlight<StatusRead | null>());

  const lifecycle = status?.lifecycle ?? LOADING;
  const mode = homeMode(lifecycle, account, accountRead);
  const friendOffer = account?.plan.friendPrice ?? null;
  // Paddle is asked for the usual price only while Home asks an owner without a friend
  // offer to subscribe.
  const price = usePaddlePricePreview(
    mode.kind === "subscribe" && showsUsualPrice(friendOffer) ? priceId : null
  );
  const inHome = mode.kind === "home";
  const clock: Clock = useMemo(() => ({ now }), [now]);

  // --- Reads ---

  const refreshStatus = useCallback(async (): Promise<StatusRead | null> => {
    return statusFlight.current(async () => {
      try {
        const next = await readStatus();
        if (mounted.current) setStatus(next);
        return next;
      } catch (error) {
        if (error instanceof SignedOutError) {
          goToSignIn();
          return null;
        }
        if (mounted.current) {
          setStatus((current) => ({
            lifecycle: UNREACHABLE,
            storage: current?.storage ?? null,
            exportSummary: current?.exportSummary ?? null,
            connectorUrl: current?.connectorUrl ?? null,
          }));
        }
        return null;
      }
    });
  }, []);

  // A failed read keeps an account read before; with none, Home says it is unknown.
  const accountKnown = useRef(false);
  const refreshAccount = useCallback(async () => {
    try {
      const next = await readAccount();
      if (!mounted.current) return;
      if (next.account) {
        accountKnown.current = true;
        setAccount(next.account);
        setBilling(next.billing);
        setAccountRead("known");
      } else if (!accountKnown.current) {
        setAccountRead("failed");
      }
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else if (mounted.current && !accountKnown.current) setAccountRead("failed");
    }
  }, []);

  const refreshApps = useCallback(async () => {
    try {
      const next = await readApps();
      if (!mounted.current) return;
      setApps(next);
      setAppsFailed(next === null);
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else if (mounted.current) setAppsFailed(true);
    }
  }, []);

  const refreshLevels = useCallback(async () => {
    try {
      const next = await readLevels();
      if (mounted.current) setLevels(next);
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
    }
  }, []);

  const refreshActivity = useCallback(async () => {
    try {
      const next = await readActivity();
      if (!mounted.current) return;
      setActivity(next);
      setActivityAt(Date.now());
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
    }
  }, []);

  // Status: on load, then quickly while the cell changes state, else every 30 s.
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    async function poll() {
      // An account that could not be read is asked for again with each status read.
      if (attempt > 0 && !accountKnown.current && visibleNow()) void refreshAccount();
      const next = visibleNow() ? await refreshStatus() : null;
      if (cancelled) return;
      const lifecycleNow = next?.lifecycle;
      if (lifecycleNow?.state === "deleted") return;
      const fast = lifecycleNow ? nextStatusPollDelayMs(lifecycleNow, attempt) : null;
      attempt += 1;
      timer = window.setTimeout(() => void poll(), fast ?? REFRESH_MS);
    }
    async function start() {
      await Promise.all([poll(), refreshAccount()]);
    }
    void start();
    return () => {
      cancelled = true;
      mounted.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshStatus, refreshAccount]);

  // The rest of Home reads once the page knows it is Home, and again on a return to the
  // tab, unless the last full read is under 30 s old.
  const lastFullRead = useRef(0);
  useEffect(() => {
    if (!inHome) return;
    async function load() {
      lastFullRead.current = Date.now();
      await Promise.all([refreshApps(), refreshLevels(), refreshActivity()]);
    }
    void load();
    const activityTimer = window.setInterval(() => {
      if (visibleNow()) void refreshActivity();
    }, REFRESH_MS);
    const onVisible = () => {
      if (!visibleNow() || Date.now() - lastFullRead.current < REFRESH_MS) return;
      lastFullRead.current = Date.now();
      void refreshStatus();
      void refreshAccount();
      void refreshApps();
      void refreshLevels();
      void refreshActivity();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(activityTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [inHome, refreshStatus, refreshAccount, refreshApps, refreshLevels, refreshActivity]);

  // "12 s ago" ticks in the browser.
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (visibleNow()) setNow(Date.now());
    }, 1000);
    return () => window.clearInterval(tick);
  }, []);

  // --- Actions ---

  async function onSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setPageMessage(null);
    const ok = await signOut().catch(() => false);
    setSigningOut(false);
    if (ok) setSignedOut(true);
    else setPageMessage("We could not sign you out. Your session is still active. Try again.");
  }

  async function onBilling(kind: "portal" | "checkout") {
    setBillingBusy(true);
    setPageMessage(null);
    try {
      const destination = await billingDestination(kind);
      if (destination) {
        window.location.assign(destination);
        return;
      }
      setPageMessage("Billing didn’t open. Try again in a minute.");
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else setPageMessage("Billing didn’t open. Try again in a minute.");
    } finally {
      if (mounted.current) setBillingBusy(false);
    }
  }

  async function onDisconnect(app: HomeApp): Promise<boolean> {
    try {
      const result = await disconnectApp(app.id);
      if (result === "failed") return false;
      setDisconnected((current) => new Set(current).add(app.id));
      return true;
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      return false;
    }
  }

  async function onLevel(context: LevelContext, level: LevelKey, revision: string) {
    setLevelPending(context);
    setLevelMessage(null);
    try {
      const result = await writeLevel(context, level, revision);
      if (result.view) setLevels(result.view);
      if (result.kind === "refused") setLevelMessage(levelRefusalText(result.code));
      if (result.kind === "failed") setLevelMessage(levelRefusalText("FAILED"));
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else setLevelMessage(levelRefusalText("FAILED"));
    } finally {
      if (mounted.current) setLevelPending(null);
    }
  }

  async function onExport() {
    setExportBusy(true);
    setExportMessage(null);
    try {
      const result = await startExport(crypto.randomUUID());
      if (result.kind === "started") {
        setStatus((current) => (current ? { ...current, exportSummary: result.summary } : current));
      } else {
        setExportMessage(exportRefusalText(result.code, result.retryAfterMs, { now: Date.now() }));
        if (result.code === "EXPORT_IN_PROGRESS") void refreshStatus();
      }
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else setExportMessage(exportRefusalText("FAILED", null, { now: Date.now() }));
    } finally {
      if (mounted.current) setExportBusy(false);
    }
  }

  async function onDownload(exportId: string) {
    setDownloadBusy(true);
    setExportMessage(null);
    try {
      for (let attempt = 1; attempt <= LINK_ATTEMPTS; attempt += 1) {
        const link = await requestExportLink(exportId);
        if (link.kind === "link") {
          // The link is an attachment that lasts minutes; it is used now and never kept.
          window.location.assign(link.url);
          return;
        }
        if (link.kind === "refused") {
          // Expired or not ready: the status poll shows which.
          void refreshStatus();
          if (link.code !== "EXPORT_EXPIRED" && link.code !== "EXPORT_NOT_READY") {
            setExportMessage("The download didn’t start. Try again in a minute.");
          }
          return;
        }
        if (attempt < LINK_ATTEMPTS) {
          await new Promise((resolve) => window.setTimeout(resolve, LINK_RETRY_MS));
        }
      }
      setExportMessage("The download link isn’t ready yet. Try again in a minute.");
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else setExportMessage("The download didn’t start. Try again in a minute.");
    } finally {
      if (mounted.current) setDownloadBusy(false);
    }
  }

  async function onSendDeletion() {
    setDeleteStep("sending");
    // An answer moves the dialog on only while it still waits; a closed dialog stays closed.
    const settle = (step: DeleteStep) =>
      setDeleteStep((current) => (current === "sending" ? step : current));
    try {
      const result = await requestDeletion();
      if (!result.ok) {
        settle("failed");
        return;
      }
      setDeleteMinutes(deletionLinkMinutes(result.expiresAt, result.serverDate));
      settle("sent");
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else settle("failed");
    }
  }

  function copyReference(reference: string) {
    navigator.clipboard?.writeText(reference).then(
      () => {
        setReferenceCopied(true);
        window.setTimeout(() => mounted.current && setReferenceCopied(false), 1800);
      },
      () => undefined
    );
  }

  // --- Render ---

  const reviewer = account?.kind === "reviewer";
  const shownEmail = account ? (reviewer ? "reviewer (sample account)" : account.email) : null;
  const header = (
    <HomeHeader email={shownEmail} onSignOut={() => void onSignOut()} signingOut={signingOut} />
  );
  const dialogs = (
    <>
      <DeleteDialog
        step={deleteStep}
        linkMinutes={deleteMinutes}
        exportOffered={exportOffered}
        onSend={() => void onSendDeletion()}
        onClose={() => setDeleteStep(null)}
      />
      <SignedOutDialog open={signedOut} onDone={() => window.location.replace("/exomem")} />
    </>
  );
  const message = pageMessage && (
    <div role="alert">
      <Notice layout="row">{pageMessage}</Notice>
    </div>
  );
  // Paddle returns a checkout here with a transaction to open; the opener checks it
  // first. It sits at the same place in every mode, so a mode change keeps its state.
  const checkoutReturn = (
    <PaddleTransactionOpener
      validationEndpoint="/api/exomem/billing/checkout"
      FailureView={CheckoutReturnFailure}
    />
  );

  if (mode.kind !== "home") {
    const copy = NOT_HOME_COPY[mode.kind];
    const subscribe = mode.kind === "subscribe" ? subscribeView(friendOffer, price) : null;
    const reference = account?.supportReference ?? lifecycle.requestId ?? null;
    return (
      <>
        <HomeWeb live={false} />
        {header}
        <div className={styles.column} aria-busy={mode.kind === "loading" || undefined}>
          <StatusBlock
            live={false}
            headline={copy.headline}
            statusLine={subscribe ? subscribe.line : copy.line}
            liveLine={null}
          />
          {subscribe?.friendCard ? <PriceCard {...subscribe.friendCard} /> : null}
          {message}
          {checkoutReturn}
          {mode.kind === "subscribe" && (
            <div>
              <Button
                variant="primary"
                size="page"
                working={billingBusy}
                onClick={() => void onBilling("checkout")}
              >
                Subscribe
              </Button>
            </div>
          )}
          {(mode.kind === "preparing" || mode.kind === "deleting") && reference && (
            <span className={styles.measured}>Support reference: {reference}</span>
          )}
          {mode.kind === "preparing" && (
            <div>
              <Button onClick={() => void refreshStatus()}>Check again</Button>
            </div>
          )}
        </div>
        {dialogs}
      </>
    );
  }

  const variant = mode.variant;
  const live = isLive(variant);
  const facts = activityFacts(activity, activityAt);
  const shownApps = apps ?? [];
  const status_ = statusCopy(variant, reviewer, facts, clock);
  const storage = storageView(status?.storage ?? null, clock);
  const homeNotices = notices(variant, account, storage, exportOffered);
  const first = live ? firstNoteLine(facts, clock) : null;
  const accountBanner = banner(variant, account, billing, clock, exportOffered);
  const exportSummary = status?.exportSummary;
  const exportRow =
    exportSummary && exportSummary !== NOT_RELEASED ? exportView(exportSummary, clock) : null;
  const levelState = levelsView(levels);
  const codingLevel =
    levels && levels !== NOT_RELEASED && levels.state === "live"
      ? levels.levels.coding.level
      : "balanced";
  const bannerLabel = {
    fix_billing: "Fix billing",
    resubscribe: "Resubscribe",
    resume: "Resume subscription",
  };

  return (
    <>
      <HomeWeb live={live} />
      {header}
      <div className={styles.column}>
        <StatusBlock
          live={live}
          headline={status_.headline}
          statusLine={status_.statusLine}
          liveLine={variant === "ended" ? null : liveLine(facts, shownApps, disconnected, clock)}
          activityNote={variant === "ended" ? null : activityUnavailableText(activity)}
        />
        {message}
        {checkoutReturn}
        {homeNotices.map((notice) => (
          <Notice
            key={notice.key}
            layout="row"
            attention={notice.attention}
            action={
              notice.action === "copy_reference" && account ? (
                <Button
                  size="detail"
                  onClick={() => copyReference(account.supportReference)}
                  aria-live="polite"
                >
                  {referenceCopied ? "Copied" : "Copy reference"}
                </Button>
              ) : notice.action === "support" ? (
                <a className={`${styles.inlineButton} ${phone.hitArea}`} href="/exomem/support">
                  Contact support
                </a>
              ) : undefined
            }
          >
            {notice.text}
          </Notice>
        ))}
        {first && (
          <div className={styles.firstNote}>
            <span className={styles.firstDot} aria-hidden="true" />
            <div className={styles.firstText}>
              <span>Your first note</span>
              <span className={styles.firstMeta}>{first}</span>
            </div>
          </div>
        )}
        {accountBanner && (
          <Notice
            layout="row"
            action={
              accountBanner.action ? (
                <Button
                  variant="primary"
                  size="row"
                  working={billingBusy}
                  onClick={() =>
                    void onBilling(accountBanner.action === "resubscribe" ? "checkout" : "portal")
                  }
                >
                  {bannerLabel[accountBanner.action]}
                </Button>
              ) : undefined
            }
          >
            {accountBanner.text}
          </Notice>
        )}
        <ConnectedApps
          apps={shownApps}
          failed={appsFailed}
          ended={variant === "ended"}
          disconnected={disconnected}
          onDisconnect={onDisconnect}
          connectorUrl={status?.connectorUrl ?? null}
          startLevel={codingLevel}
          reviewer={reviewer}
          clock={clock}
        />
        <InvolvementLevels
          view={levelState}
          pending={levelPending}
          message={levelMessage}
          onChange={(context, level, revision) => void onLevel(context, level, revision)}
        />
        <PlanAndAccount
          plan={planView(variant, account, billing, clock)}
          storage={storage}
          email={shownEmail}
          onBilling={(kind) => void onBilling(kind)}
          billingBusy={billingBusy}
        />
        <YourData
          exportRow={exportRow}
          exportBusy={exportBusy}
          exportMessage={exportMessage}
          downloadBusy={downloadBusy}
          onExport={() => void onExport()}
          onDownload={(exportId) => void onDownload(exportId)}
          deletion={account?.kind ?? null}
          onDelete={() => setDeleteStep("ask")}
        />
        <div className={styles.footer}>Everything else happens in your assistant.</div>
      </div>
      {dialogs}
    </>
  );
}

/** A checkout return that could not be checked or opened, as a Home notice. */
function CheckoutReturnFailure({ message, retry, dismiss }: PaddleTransactionFailure) {
  return (
    <Notice
      layout="row"
      action={
        <div className={styles.noticeActions}>
          <Button variant="primary" size="detail" onClick={retry}>
            Try again
          </Button>
          <Button size="detail" onClick={dismiss}>
            Not now
          </Button>
        </div>
      }
    >
      {message}
    </Notice>
  );
}

// The states before and after a working Home. The board draws none of them: the
// subscribe copy is the journey's (Appendix A), the rest is the current Home's.
const NOT_HOME_COPY: Record<
  "loading" | "subscribe" | "preparing" | "deleting" | "deleted",
  { headline: string; line: string | null }
> = {
  loading: { headline: "One moment.", line: "Checking your Exomem…" },
  // The line carries the price when Paddle previews it: subscribeView writes it.
  subscribe: { headline: "Subscribe to finish setting up", line: null },
  preparing: {
    headline: "Your Exomem is taking shape.",
    line: "This usually takes a minute or two. You can leave this page open; it will continue automatically.",
  },
  deleting: {
    headline: "Closing your Exomem.",
    line: "Access is now closed while the private vault and its backups are removed.",
  },
  deleted: {
    headline: "This Exomem has been removed.",
    line: "Your Exomem Cloud account is gone. Any other Substrate account or product is unaffected.",
  },
};
