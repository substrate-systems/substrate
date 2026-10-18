"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/exomem/Button";
import { Notice } from "@/components/exomem/Notice";
import { StorageDialog } from "./home-storage";
import { usePaddlePricePreview } from "@/lib/paddle";
import { PENDING_TRANSACTION_KEY } from "@/components/PaddleTransactionOpener";
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
import { breakCopy, consentCopy, inviteCopy } from "../_journey/copy";
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
import { activityEventKey, createActivityObserver, type ActivityEvent } from "./home-activity";

/** Home reads activity, and the status poll, this often while the tab is visible. */
const REFRESH_MS = 30_000;
/** A pending download link is asked for again this many times, this far apart. */
const LINK_ATTEMPTS = 3;
const LINK_RETRY_MS = 2_000;
const BILLING_FAILED = "Billing didn’t open. Try again in a minute.";
type BillingControl = "subscribe" | "banner" | "plan";

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
  channelOn,
  statusPageUrl,
  storageOffered = false,
}: {
  priceId: string | null;
  /** Whether Home offers an export: the export flag (design.md deviation (s)). */
  exportOffered: boolean;
  /**
   * The Home channel's release flag. Off, its levels and activity routes answer 404, so
   * Home asks neither and leaves both out (design.md deviation (u)).
   */
  channelOn: boolean;
  /** "Status page ↗" on the trouble notice; null when none is configured. */
  statusPageUrl: string | null;
  storageOffered?: boolean;
  viewerOffered?: boolean;
}) {
  const [status, setStatus] = useState<StatusRead | null>(null);
  const [account, setAccount] = useState<HomeAccount | null>(null);
  const [accountRead, setAccountRead] = useState<AccountRead>("loading");
  const [billing, setBilling] = useState<HomeBilling | null>(null);
  const [apps, setApps] = useState<HomeApp[] | null>(null);
  const [appsFailed, setAppsFailed] = useState(false);
  const [levels, setLevels] = useState<HomeLevels | typeof NOT_RELEASED | null>(
    channelOn ? null : NOT_RELEASED
  );
  const [activity, setActivity] = useState<HomeActivity | typeof NOT_RELEASED | null>(
    channelOn ? null : NOT_RELEASED
  );
  // The browser's time when the activity arrived: ages are read on the cell's clock.
  const [activityAt, setActivityAt] = useState(0);
  const [activityPulse, setActivityPulse] = useState<ActivityEvent | null>(null);
  const observeActivity = useRef(createActivityObserver());
  useEffect(() => {
    if (!activityPulse) return;
    const timer = window.setTimeout(() => setActivityPulse(null), 3_000);
    return () => window.clearTimeout(timer);
  }, [activityPulse]);
  const [now, setNow] = useState(() => Date.now());

  const [disconnected, setDisconnected] = useState<ReadonlySet<string>>(new Set());
  const [levelPending, setLevelPending] = useState<LevelContext | null>(null);
  const [levelMessage, setLevelMessage] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingError, setBillingError] = useState<{
    control: BillingControl;
    text: string;
  } | null>(null);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [deleteStep, setDeleteStep] = useState<DeleteStep | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [deleteMinutes, setDeleteMinutes] = useState<number | null>(null);
  const [referenceCopied, setReferenceCopied] = useState(false);

  const mounted = useRef(true);
  const statusFlight = useRef(createSingleFlight<StatusRead | null>());
  const lastStatusAt = useRef<number | null>(null);
  const [lostAt, setLostAt] = useState<number | null>(null);
  const [statusRetryAt, setStatusRetryAt] = useState<number | null>(null);
  const [activityReadFailed, setActivityReadFailed] = useState(false);
  useEffect(() => {
    try {
      const returned = window.sessionStorage.getItem(PENDING_TRANSACTION_KEY);
      if (returned) window.location.replace(`/exomem/setup?_ptxn=${encodeURIComponent(returned)}`);
    } catch {
      /* The URL return works when browser storage is unavailable. */
    }
  }, []);

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
        if (mounted.current) {
          lastStatusAt.current = Date.now();
          setLostAt(null);
          setStatusRetryAt(null);
          setStatus(next);
        }
        return next;
      } catch (error) {
        if (error instanceof SignedOutError) {
          goToSignIn();
          return null;
        }
        if (mounted.current) {
          setLostAt(lastStatusAt.current ?? 0);
          setStatus(
            (current) =>
              current ?? {
                lifecycle: UNREACHABLE,
                storage: null,
                exportSummary: null,
                connectorUrl: null,
              }
          );
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
    if (!channelOn) return;
    try {
      const next = await readLevels();
      if (mounted.current) setLevels(next);
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
    }
  }, [channelOn]);

  const refreshActivity = useCallback(async () => {
    if (!channelOn) return;
    try {
      const next = await readActivity();
      if (!mounted.current) return;
      setActivity(next);
      if (next !== NOT_RELEASED) {
        const fresh = observeActivity.current(next);
        if (fresh) setActivityPulse(fresh);
      }
      setActivityAt(Date.now());
      setActivityReadFailed(false);
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else if (mounted.current) setActivityReadFailed(true);
    }
  }, [channelOn]);

  // Status: on load, then quickly while the cell changes state, else every 30 s.
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: number | undefined;
    let attempt = 0;
    let failures = 0;
    async function poll() {
      // An account that could not be read is asked for again with each status read.
      if (attempt > 0 && !accountKnown.current && visibleNow()) void refreshAccount();
      const next = visibleNow() ? await refreshStatus() : null;
      if (cancelled) return;
      const lifecycleNow = next?.lifecycle;
      if (lifecycleNow?.state === "deleted") return;
      const fast = lifecycleNow ? nextStatusPollDelayMs(lifecycleNow, attempt) : null;
      attempt += 1;
      const delay =
        next || !visibleNow() ? (fast ?? REFRESH_MS) : Math.min(60_000, 8_000 * 2 ** failures++);
      if (next) failures = 0;
      else if (visibleNow()) setStatusRetryAt(Date.now() + delay);
      timer = window.setTimeout(() => void poll(), delay);
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

  async function onBilling(kind: "portal" | "checkout", control: BillingControl) {
    if (kind === "checkout") {
      window.location.assign("/exomem/setup");
      return;
    }
    setBillingBusy(true);
    try {
      const destination = await billingDestination(kind);
      if (destination) {
        window.location.assign(destination);
        return;
      }
      setBillingError({ control, text: BILLING_FAILED });
    } catch (error) {
      if (error instanceof SignedOutError) goToSignIn();
      else setBillingError({ control, text: BILLING_FAILED });
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
    <HomeHeader
      email={shownEmail}
      onSignOut={() => void onSignOut()}
      signingOut={signingOut}
      live={lostAt === null && mode.kind === "home" && isLive(mode.variant)}
      activityKey={
        lostAt === null && !activityReadFailed && activityPulse
          ? activityEventKey(activityPulse)
          : undefined
      }
    />
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
          {mode.kind === "subscribe" && (
            <div>
              <Button
                variant="primary"
                size="page"
                working={billingBusy}
                onClick={() => void onBilling("checkout", "subscribe")}
              >
                Subscribe
              </Button>
              <div className={styles.billingStatus} role="alert">
                {billingError?.control === "subscribe" ? billingError.text : null}
              </div>
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
  const live = isLive(variant) && lostAt === null;
  const facts = activityReadFailed && lostAt === null ? null : activityFacts(activity, activityAt);
  const pulseAppIndex = activityPulse?.app_id
    ? (apps?.findIndex((app) => app.id === activityPulse.app_id) ?? -1)
    : -1;
  const pulseApp =
    live &&
    !activityReadFailed &&
    pulseAppIndex >= 0 &&
    apps &&
    !disconnected.has(apps[pulseAppIndex].id)
      ? apps[pulseAppIndex]
      : null;
  const status_ = statusCopy(variant, reviewer, facts, clock);
  const storage = storageView(status?.storage ?? null, clock);
  const homeNotices = notices(variant, account, storage, exportOffered, statusPageUrl !== null);
  const first = isLive(variant) ? firstNoteLine(facts, clock) : null;
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
    fix_billing: consentCopy.readOnly.fixBilling,
    resubscribe: breakCopy.ended.resubscribe,
    resume: breakCopy.paused.resume,
  };

  return (
    <>
      <HomeWeb
        live={live}
        activity={
          !activityReadFailed && activityPulse
            ? {
                kind: activityPulse.action === "saved" ? "save" : "recall",
                key: activityEventKey(activityPulse),
                ...(pulseApp ? { from: pulseAppIndex, of: apps!.length } : {}),
              }
            : undefined
        }
      />
      {header}
      <div className={`${styles.column} ${styles.homeColumn}`}>
        <StatusBlock
          live={live}
          headline={
            lostAt === null
              ? status_.headline
              : lostAt === 0
                ? "Can’t reach Exomem."
                : `${status_.headline} · as of ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(lostAt)}`
          }
          statusLine={status_.statusLine}
          liveLine={
            variant === "ended" || (activityReadFailed && lostAt === null)
              ? null
              : liveLine(facts, apps ?? [], disconnected, clock)
          }
          activityNote={variant === "ended" ? null : activityUnavailableText(activity)}
        />
        <div className={styles.columns}>
          <div className={styles.primaryColumn}>
            {message}
            {lostAt !== null && (
              <Notice
                layout="row"
                action={
                  <Button size="detail" onClick={() => void refreshStatus()}>
                    Try now
                  </Button>
                }
              >
                Can’t reach Exomem.{" "}
                {lostAt > 0 ? "Showing the last successful read. " : "We will try again. "}{" "}
                {statusRetryAt
                  ? `Checking again in ${Math.max(0, Math.ceil((statusRetryAt - now) / 1000))} seconds.`
                  : "Trying again."}
              </Notice>
            )}
            {homeNotices.map((notice) => (
              <Notice
                key={notice.key}
                layout="row"
                attention={notice.attention}
                action={
                  notice.actions.length ? (
                    <div className={styles.noticeActions}>
                      {notice.actions.map((action) =>
                        action === "copy_reference" && account ? (
                          <Button
                            key={action}
                            size="detail"
                            onClick={() => copyReference(account.supportReference)}
                            aria-live="polite"
                          >
                            <span className={styles.copyLabel}>
                              <span className={styles.copyReserve} aria-hidden="true">
                                Copy reference
                              </span>
                              <span>{referenceCopied ? "Copied" : "Copy reference"}</span>
                            </span>
                          </Button>
                        ) : action === "status_page" && statusPageUrl ? (
                          <ButtonLink
                            key={action}
                            size="detail"
                            href={statusPageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {breakCopy.connectError.statusPage}
                          </ButtonLink>
                        ) : action === "support" ? (
                          <ButtonLink key={action} size="detail" href="/exomem/support">
                            Contact support
                          </ButtonLink>
                        ) : null
                      )}
                    </div>
                  ) : undefined
                }
              >
                {notice.text}
              </Notice>
            ))}
            {first && (
              <div className={styles.firstNote}>
                <span
                  className={live ? styles.firstDot : styles.firstDotQuiet}
                  aria-hidden="true"
                />
                <div className={styles.firstText}>
                  <span>Your first note</span>
                  <span className={styles.firstMeta}>{first}</span>
                </div>
              </div>
            )}
            {accountBanner && (
              <div>
                <Notice
                  layout="row"
                  action={
                    accountBanner.action ? (
                      <Button
                        variant="primary"
                        size="account"
                        working={billingBusy}
                        onClick={() =>
                          void onBilling(
                            accountBanner.action === "resubscribe" ? "checkout" : "portal",
                            "banner"
                          )
                        }
                      >
                        {bannerLabel[accountBanner.action]}
                      </Button>
                    ) : undefined
                  }
                >
                  {accountBanner.text}
                </Notice>
                {accountBanner.action && (
                  <div className={styles.billingStatus} role="alert">
                    {billingError?.control === "banner" ? billingError.text : null}
                  </div>
                )}
              </div>
            )}
            <ConnectedApps
              apps={apps}
              failed={appsFailed}
              ended={variant === "ended"}
              checkoutAvailable={billing?.checkoutAvailable ?? false}
              disconnected={disconnected}
              onDisconnect={onDisconnect}
              connectorUrl={status?.connectorUrl ?? null}
              startLevel={codingLevel}
              reviewer={reviewer}
              clock={clock}
              activeAppId={pulseApp?.id ?? null}
            />
            <InvolvementLevels
              view={levelState}
              pending={levelPending}
              message={levelMessage}
              onChange={(context, level, revision) => void onLevel(context, level, revision)}
            />
            <div className={styles.dataSection}>
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
            </div>
          </div>
          <div className={styles.secondaryColumn}>
            <PlanAndAccount
              plan={planView(variant, account, billing, clock)}
              storage={storage}
              email={shownEmail}
              onBilling={(kind) => void onBilling(kind, "plan")}
              billingBusy={billingBusy}
              billingMessage={billingError?.control === "plan" ? billingError.text : null}
              onStorage={
                storageOffered && !reviewer && variant === "on" && billing?.source === "paddle"
                  ? () => setStorageOpen(true)
                  : undefined
              }
            />
          </div>
        </div>
        <div className={styles.footer}>Everything else happens in your assistant.</div>
      </div>
      {dialogs}
      {storageOpen && account?.kind === "owner" && (
        <StorageDialog
          key={account.email}
          email={account.email}
          onClose={() => {
            setStorageOpen(false);
            void refreshStatus();
            void refreshAccount();
          }}
          onAccountLost={goToSignIn}
        />
      )}
    </>
  );
}

// The states before and after a working Home. The board draws none of them: the
// subscribe and preparing copy is the journey's (Appendix A; design.md (ad), (aa)), the
// rest is the current Home's.
const NOT_HOME_COPY: Record<
  "loading" | "subscribe" | "preparing" | "deleting" | "deleted",
  { headline: string; line: string | null }
> = {
  loading: { headline: "One moment.", line: "Checking your Exomem…" },
  // The line carries the price when Paddle previews it: subscribeView writes it.
  subscribe: { headline: "Subscribe to finish setting up", line: null },
  preparing: { headline: inviteCopy.accepting.title, line: inviteCopy.accepting.lede },
  deleting: {
    headline: "Closing your Exomem.",
    line: "Access is now closed while the private vault and its backups are removed.",
  },
  deleted: {
    headline: "This Exomem has been removed.",
    line: "Your Exomem Cloud account is gone. Any other Substrate account or product is unaffected.",
  },
};
