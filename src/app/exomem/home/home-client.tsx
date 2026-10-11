"use client";

import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  friendlyHostedError,
  getPrivateJson,
  HostedBrowserError,
  postPrivateJson,
} from "@/lib/exomem-hosted/hosted-browser";
import { type PaddlePricePreview, usePaddlePricePreview } from "@/lib/paddle";
import styles from "../private-shell.module.css";
import {
  type Lifecycle,
  type LifecycleState,
  type InstallAction,
  createSingleFlight,
  nextStatusPollDelayMs,
  parseCloudConnectorUrl,
  parseInstallActions,
  parseLifecycleResponse,
} from "./home-state";
import { type HomeSection, homeSections } from "./home-sections";
import {
  type PromLevel,
  assistantInstructions,
  CLIENT_GUIDES,
  DEFAULT_PROM_LEVEL,
  PROM_CONTRACTS,
  PROM_LEVELS,
} from "./assistant-instructions";

function lifecycleCopy(state: LifecycleState): { eyebrow: string; title: string; body: string } {
  switch (state) {
    case "awaiting_payment":
      return {
        eyebrow: "Private alpha",
        title: "Subscribe before we prepare your Exomem.",
        body: "Your place is reserved. Paddle handles payment securely, and preparation starts only after your subscription is confirmed.",
      };
    case "preparing":
      return {
        eyebrow: "Preparing your private space",
        title: "Your Exomem is taking shape.",
        body: "This usually takes a minute or two. You can leave this page open; it will continue automatically.",
      };
    case "degraded":
      return {
        eyebrow: "Temporarily unavailable",
        title: "Your memories are safe.",
        body: "Exomem is having trouble waking up. We are retrying without moving your data anywhere else.",
      };
    case "suspended":
      return {
        eyebrow: "Paused",
        title: "Your Exomem is paused.",
        body: "Your memories remain stored, but capture and recall are unavailable until access is resumed.",
      };
    case "deletion_pending":
      return {
        eyebrow: "Deletion in progress",
        title: "Closing your Exomem.",
        body: "Access is now closed while the private vault and its backups are removed.",
      };
    case "deleted":
      return {
        eyebrow: "Deleted",
        title: "This Exomem has been removed.",
        body: "Your Exomem Cloud account is gone. Any other Substrate account or product is unaffected.",
      };
    default:
      return {
        eyebrow: "Opening your private space",
        title: "One moment.",
        body: "Checking your Exomem…",
      };
  }
}

function billingCadence(cycle: PaddlePricePreview["billingCycle"]): string {
  if (!cycle) return "";
  return cycle.frequency === 1
    ? ` per ${cycle.interval}`
    : ` every ${cycle.frequency} ${cycle.interval}s`;
}

// Mounted only on the subscribe card, so no other lifecycle state asks Paddle.
function SubscriptionPrice({ priceId }: { priceId: string | null }) {
  const preview = usePaddlePricePreview(priceId);
  return (
    <p className={styles.secondaryCopy}>
      {preview
        ? `${preview.total}${billingCadence(preview.billingCycle)}${preview.includesTax ? ", including tax" : ""}. Cancel through Paddle.`
        : // Short enough to keep the Subscribe button on one line at desktop width.
          "Paddle shows the price at checkout. Cancel through Paddle."}
    </p>
  );
}

export default function HomeClient({
  serverUrl,
  priceId,
}: {
  serverUrl: string;
  priceId: string | null;
}) {
  const [lifecycle, setLifecycle] = useState<Lifecycle>({
    state: "loading",
    code: "TENANT_PREPARING",
    retryable: true,
  });
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [deletionRequested, setDeletionRequested] = useState(false);
  const [billing, setBilling] = useState<{
    source: "complimentary" | "paddle";
    state: string;
    checkoutAvailable: boolean;
    portalAvailable: boolean;
  } | null>(null);
  const [installActions, setInstallActions] = useState<InstallAction[]>([]);
  // Item 6 / task 3.7: null until /api/exomem/status returns one (only ever
  // happens under EXOMEM_CLOUD_ENABLED) -- flag off, this never leaves null
  // and every render below falls through to the hosted `serverUrl` prop
  // exactly as before.
  const [cloudConnectorUrl, setCloudConnectorUrl] = useState<string | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const [promLevel, setPromLevel] = useState<PromLevel>(DEFAULT_PROM_LEVEL);
  const [instructionsCopied, setInstructionsCopied] = useState(false);
  const mountedRef = useRef(true);
  const statusSingleFlightRef = useRef(createSingleFlight<Lifecycle>());

  const loadStatus = useCallback(async (): Promise<Lifecycle> => {
    try {
      const response = await getPrivateJson("/api/exomem/status");
      const next = parseLifecycleResponse(response);
      if (!next) throw new Error("invalid status");
      const connectorUrl = parseCloudConnectorUrl(response);
      if (connectorUrl) setCloudConnectorUrl(connectorUrl);
      return next;
    } catch (error) {
      if (error instanceof HostedBrowserError && error.status === 401) throw error;
      return { state: "degraded", code: "CELL_UNAVAILABLE", retryable: true };
    }
  }, []);

  const refreshStatus = useCallback(async (): Promise<Lifecycle | null> => {
    let next: Lifecycle;
    try {
      next = await statusSingleFlightRef.current(loadStatus);
    } catch (error) {
      if (mountedRef.current && error instanceof HostedBrowserError && error.status === 401) {
        window.location.replace("/exomem/sign-in");
      }
      return null;
    }
    if (!mountedRef.current) return null;
    setLifecycle((current) =>
      next.requestId || !current.requestId ? next : { ...next, requestId: current.requestId }
    );
    return next;
  }, [loadStatus]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let timer: number | undefined;

    async function poll(attempt: number): Promise<void> {
      const next = await refreshStatus();
      if (cancelled || !next) return;
      const delay = nextStatusPollDelayMs(next, attempt);
      if (delay !== null) {
        timer = window.setTimeout(() => void poll(attempt + 1), delay);
      }
    }

    void poll(0);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (lifecycle.state !== "ready" && lifecycle.state !== "awaiting_payment") return;
    void getPrivateJson("/api/exomem/account")
      .then((response) => {
        setInstallActions(parseInstallActions(response));
        const value = response.billing;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const candidate = value as Record<string, unknown>;
        if (
          (candidate.source === "complimentary" || candidate.source === "paddle") &&
          typeof candidate.state === "string" &&
          typeof candidate.checkoutAvailable === "boolean" &&
          typeof candidate.portalAvailable === "boolean"
        ) {
          setBilling({
            source: candidate.source,
            state: candidate.state,
            checkoutAvailable: candidate.checkoutAvailable,
            portalAvailable: candidate.portalAvailable,
          });
        }
      })
      .catch(() => undefined);
  }, [lifecycle.state]);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setNotice("Signing out…");
    setNoticeError(false);
    try {
      await postPrivateJson("/api/exomem/access/logout", {});
    } catch {
      setNotice("We could not sign you out. Your session is still active. Try again.");
      setNoticeError(true);
      setSigningOut(false);
      return;
    }
    window.location.replace("/exomem/sign-in");
  }

  async function requestDeletion() {
    setNotice("Sending a fresh deletion confirmation…");
    setNoticeError(false);
    try {
      await postPrivateJson("/api/exomem/deletion/request", {});
      setDeletionRequested(true);
      setNotice("Check your email to review and confirm deletion. Nothing has been deleted yet.");
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    }
  }

  async function openBilling(kind: "checkout" | "portal") {
    setNotice("Opening secure billing…");
    setNoticeError(false);
    try {
      const response = await postPrivateJson(`/api/exomem/billing/${kind}`, {});
      const destination = kind === "checkout" ? response.checkoutUrl : response.portalUrl;
      if (typeof destination !== "string") throw new Error("missing billing destination");
      window.location.assign(destination);
    } catch (error) {
      setNotice(friendlyHostedError(error));
      setNoticeError(true);
    }
  }

  if (lifecycle.state !== "ready") {
    const copy = lifecycleCopy(lifecycle.state);
    if (lifecycle.state === "awaiting_payment") {
      return (
        <section className={styles.card} aria-labelledby="lifecycle-title">
          <div className={styles.workspaceHeader}>
            <div>
              <p className={styles.eyebrow}>{copy.eyebrow}</p>
              <h1 className={styles.title} id="lifecycle-title">
                {copy.title}
              </h1>
            </div>
            <button
              className={styles.quietButton}
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
          <p className={styles.lede}>{copy.body}</p>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Exomem Cloud private alpha</strong>
              <SubscriptionPrice priceId={priceId} />
            </div>
            <button
              className={styles.button}
              type="button"
              onClick={() => void openBilling("checkout")}
            >
              Subscribe and prepare Exomem
            </button>
          </div>
          <p className={`${styles.status} ${noticeError ? styles.error : ""}`} aria-live="polite">
            {notice}
          </p>
        </section>
      );
    }
    return (
      <section className={styles.card} aria-labelledby="lifecycle-title">
        <div className={styles.workspaceHeader}>
          <div>
            <p className={styles.eyebrow}>{copy.eyebrow}</p>
            <h1 className={styles.title} id="lifecycle-title">
              {copy.title}
            </h1>
          </div>
          <button
            className={styles.quietButton}
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
        <p className={styles.lede}>{copy.body}</p>
        {(lifecycle.state === "loading" || lifecycle.state === "preparing") && (
          <div className={styles.spinner} role="status" aria-label="Preparing Exomem" />
        )}
        <div className={styles.secondaryRow}>
          <div>
            <strong>Service status</strong>
            <p className={styles.secondaryCopy}>
              Support reference: {lifecycle.requestId ?? "not available yet"}
            </p>
          </div>
          {lifecycle.state !== "deleted" && (
            <button
              className={styles.quietButton}
              type="button"
              onClick={() => void refreshStatus()}
            >
              Check again
            </button>
          )}
        </div>
        <p className={`${styles.status} ${noticeError ? styles.error : ""}`} aria-live="polite">
          {notice}
        </p>
      </section>
    );
  }

  const sections = homeSections();
  // Item 6 / task 3.7: the Cloud connector URL, when /api/exomem/status has
  // returned one, replaces the hosted `serverUrl` prop everywhere it is
  // shown -- the same MCP server address concept, pointed at the tenant's
  // Cloud cell instead of the shared hosted MCP endpoint.
  const effectiveServerUrl = cloudConnectorUrl ?? serverUrl;

  async function copyInstructions() {
    try {
      await navigator.clipboard.writeText(assistantInstructions(promLevel));
      setInstructionsCopied(true);
      window.setTimeout(() => mountedRef.current && setInstructionsCopied(false), 2000);
    } catch {
      // Same reasoning as the server address: the text is on screen and
      // selectable, so a refused clipboard costs a manual selection.
    }
  }

  async function copyServerUrl() {
    try {
      await navigator.clipboard.writeText(cloudConnectorUrl ?? serverUrl);
      setUrlCopied(true);
      window.setTimeout(() => mountedRef.current && setUrlCopied(false), 2000);
    } catch {
      // Clipboard access can be refused outright (permissions, insecure
      // context). The URL is rendered in full beside the button, so a refusal
      // costs a manual selection rather than a dead end — say nothing.
    }
  }

  // Every section is rendered by mapping over `sections`, not written out in
  // source order — so the ordering asserted in `home-sections.test.ts` is the
  // ordering that ships, and reordering them takes a deliberate edit to the
  // data rather than an accidental one to the markup.
  const rendered: Record<HomeSection, ReactNode> = {
    connect: (
      <div className={styles.connect}>
        <p className={styles.connectTitle}>Connect an assistant</p>
        <p className={styles.resultBody}>
          Exomem is most useful inside the assistant you already talk to. Connect it once and
          Claude, ChatGPT, or Codex can recall and preserve your context without you leaving the
          conversation.
        </p>

        <p className={styles.connectLabel}>Step 1 · Your Exomem server address</p>
        <p className={styles.serverUrl}>
          <span className={styles.serverUrlValue}>{effectiveServerUrl}</span>
          <button className={styles.quietButton} type="button" onClick={() => void copyServerUrl()}>
            {urlCopied ? "Copied" : "Copy"}
          </button>
        </p>
        <p className={styles.secondaryCopy}>
          The same address for every client. You sign in once, in the browser, when your assistant
          asks.
        </p>

        <p className={styles.connectLabel}>Step 2 · How involved should it be?</p>
        <div className={styles.levelPicker} role="radiogroup" aria-label="How involved Exomem is">
          {PROM_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={promLevel === level}
              className={`${styles.tab} ${promLevel === level ? styles.activeTab : ""}`}
              onClick={() => setPromLevel(level)}
            >
              {PROM_CONTRACTS[level].label}
            </button>
          ))}
        </div>
        <p className={styles.secondaryCopy}>{PROM_CONTRACTS[promLevel].summary}</p>

        <p className={styles.secondaryCopy}>
          There is no plugin yet, so this text is what tells your assistant to use Exomem at all —
          connecting alone gives it the tools and no reason to reach for them. Paste it once.
        </p>
        <pre className={styles.connectCommands}>
          <code>{assistantInstructions(promLevel)}</code>
        </pre>
        <p className={styles.serverUrl}>
          <button
            className={styles.quietButton}
            type="button"
            onClick={() => void copyInstructions()}
          >
            {instructionsCopied ? "Copied" : "Copy instructions"}
          </button>
        </p>

        <p className={styles.connectLabel}>Where each step goes</p>
        <div className={styles.connectRoutes}>
          {CLIENT_GUIDES.map((guide) => {
            // One source of truth: a client can show an install button only if
            // it is installable at all AND the server actually published an
            // action for its platform.
            const action = guide.installable
              ? installActions.find(
                  (candidate) =>
                    candidate.platform === (guide.client === "claude" ? "claude" : "openai")
                )
              : undefined;
            return (
              <div key={guide.client}>
                <div className={styles.secondaryRow}>
                  <div>
                    <strong>{guide.name}</strong>
                    <p className={styles.secondaryCopy}>
                      {action
                        ? `One-click install · version ${action.version}`
                        : `Connect: ${guide.connect}`}
                    </p>
                    {guide.blocked ? (
                      <p className={styles.secondaryCopy}>{guide.blocked}</p>
                    ) : (
                      <p className={styles.secondaryCopy}>
                        Instructions go in: {guide.pasteTarget}
                      </p>
                    )}
                  </div>
                  {action ? (
                    <a className={styles.quietButton} href={action.installUrl}>
                      Install in {guide.name}
                    </a>
                  ) : null}
                </div>
                {guide.commands && !action ? (
                  <pre className={styles.connectCommands}>
                    <code>{guide.commands(effectiveServerUrl)}</code>
                  </pre>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    ),
    account: (
      <details className={styles.secondary}>
        {/*
          Names deletion explicitly. "Files, status, and account" gave no hint
          that leaving lives here, and the founder could not find it on their
          own workspace. A destructive action being hard to trigger by
          accident is good; being hard to find on purpose is not, and someone who
          wants their memory gone should not have to guess which heading hides it.
        */}
        <summary className={styles.summary}>Status, billing, and deleting your Exomem</summary>
        <div className={styles.secondaryBody}>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Service status</strong>
              <p className={styles.secondaryCopy}>Your private memory cell is ready.</p>
            </div>
            <button className={styles.quietButton} type="button" onClick={refreshStatus}>
              Refresh
            </button>
          </div>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Billing</strong>
              <p className={styles.secondaryCopy}>
                {billing?.source === "paddle"
                  ? `Paddle billing · ${billing.state}`
                  : "Complimentary alpha — no payment needed."}
              </p>
            </div>
            {billing?.checkoutAvailable ? (
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => void openBilling("checkout")}
              >
                Subscribe and prepare Exomem
              </button>
            ) : billing?.portalAvailable ? (
              <button
                className={styles.quietButton}
                type="button"
                onClick={() => void openBilling("portal")}
              >
                Manage billing
              </button>
            ) : null}
          </div>
          <div className={styles.secondaryRow}>
            <div>
              <strong>Delete Exomem</strong>
              <p className={styles.secondaryCopy}>
                Removes only Exomem after a fresh email confirmation.
              </p>
            </div>
            <button
              className={styles.dangerButton}
              type="button"
              onClick={requestDeletion}
              disabled={deletionRequested}
            >
              {deletionRequested ? "Confirmation sent" : "Email confirmation"}
            </button>
          </div>
        </div>
      </details>
    ),
  };

  return (
    <section className={styles.card} aria-labelledby="home-title">
      <div className={styles.workspaceHeader}>
        <div>
          <p className={styles.eyebrow}>
            <span className={styles.stateDot} aria-hidden="true" /> Ready
          </p>
          <h1 className={styles.title} id="home-title">
            Your Exomem is ready.
          </h1>
        </div>
        <button
          className={styles.quietButton}
          type="button"
          onClick={() => void signOut()}
          disabled={signingOut}
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>

      {sections.map((section) => (
        <Fragment key={section}>{rendered[section]}</Fragment>
      ))}
      <p className={`${styles.status} ${noticeError ? styles.error : ""}`} aria-live="polite">
        {notice}
      </p>
    </section>
  );
}
