"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button, ButtonLink } from "@/components/exomem/Button";
import { TextField } from "@/components/exomem/TextField";
import { EXOMEM_SIGN_IN_EVENT_KEY } from "@/lib/exomem-hosted/hosted-browser";
import { inboxProvider, inboxProviderForDomain, inboxUrl, phoneMailApp } from "@/lib/exomem/inbox";
import { currentExomemTheme, currentExomemThemeChoice } from "@/lib/exomem/theme";
import { breakCopy, failureCopy, reviewerCopy, sentCopy, startCopy } from "./copy";
import { JourneyPage, type AppTile } from "./JourneyPage";
import { openElsewhere, SentCard, StepActions, StepHeading, StepNotice } from "./parts";
import { ChallengeError, useTurnstile } from "./turnstile";
import phone from "@/components/exomem/phone.module.css";
import styles from "./journey.module.css";

type StartContext =
  | { kind: "web" }
  /** An app's consent page: the reviewer sign-in binds to its request with the form nonce. */
  | { kind: "app"; app: string; nonce: string; requestLife: string };

/** Configuration: Cloudflare's test site key locally and in tests, the real one in production. */
const SITE_KEY = process.env.NEXT_PUBLIC_EXOMEM_TURNSTILE_SITE_KEY?.trim() || null;

type StartFlowProps = {
  context: StartContext;
  reviewerEnabled: boolean;
  /** The maintained HTTPS status page; absent configuration draws no status action. */
  statusPageUrl: string | null;
  /** The frame the page draws around the steps. */
  frame: { app?: AppTile; footer?: string | null };
  /** A notice to show over the form when it first appears (signed out, a spent link). */
  notice?: { text: string; attention: boolean } | null;
  focusHeading?: boolean;
};

type StartOutcome =
  | { kind: "sent"; retryAfterSeconds: number; retryLimited: boolean }
  | { kind: "challenge_failed" | "failed" };

/**
 * POST /api/exomem/access/start. Every request that passes the challenge answers the
 * same 202, so the page never learns, and never says, whether the address has an
 * account. Only the challenge itself can fail visibly.
 */
async function requestStart(email: string, turnstileToken: string): Promise<StartOutcome> {
  let response: Response;
  try {
    response = await fetch("/api/exomem/access/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        turnstileToken,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // The page's theme, which the emails this request causes are built on.
        emailScheme: currentExomemTheme(document.documentElement),
        themeChoice: currentExomemThemeChoice(document.documentElement),
      }),
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { kind: "failed" };
  }
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    retryAfterSeconds?: unknown;
    retryLimited?: unknown;
  } | null;
  if (
    response.status === 202 &&
    typeof body?.retryAfterSeconds === "number" &&
    Number.isInteger(body.retryAfterSeconds) &&
    body.retryAfterSeconds >= 0
  ) {
    return {
      kind: "sent",
      retryAfterSeconds: body.retryAfterSeconds,
      retryLimited: body.retryLimited === true,
    };
  }
  return {
    kind:
      response.status === 400 && body?.error === "challenge_failed" ? "challenge_failed" : "failed",
  };
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function emailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/** Start with your email, check your email, and the reviewer sign-in beside them. */
export function StartFlow({
  context,
  reviewerEnabled,
  statusPageUrl,
  frame,
  notice,
  focusHeading = false,
}: StartFlowProps) {
  const [step, setStep] = useState<"form" | "sent" | "limited" | "reviewer" | "unreachable">(
    "form"
  );
  const [retryIn, setRetryIn] = useState(8);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [focusStep, setFocusStep] = useState(focusHeading);
  const [email, setEmail] = useState("");
  const [sentEmail, setSentEmail] = useState("");
  const [discoveredProvider, setDiscoveredProvider] = useState<{
    domain: string;
    id: string | null;
  } | null>(null);
  const requestVersion = useRef(0);
  const discovery = useRef<AbortController | null>(null);
  const [sentVersion, setSentVersion] = useState(0);
  const form = useRef<HTMLFormElement>(null);
  const focusEmail = useRef(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [shownNotice, setShownNotice] = useState(notice ?? null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(0);
  const {
    mount: challengeHost,
    token: challengeToken,
    reset: resetChallenge,
    start: startChallenge,
    asking,
  } = useTurnstile(SITE_KEY);
  // Under the field, and taking room only while Cloudflare shows its check.
  const challenge = (
    <div className={asking ? styles.challengeShown : styles.challenge} ref={challengeHost} />
  );

  const waitLeft = retryAt - now;
  const resendLabel = sending
    ? "Sending…"
    : waitLeft > 0
      ? sentCopy.resendIn(clock(waitLeft))
      : sentCopy.resend;
  const formNonce = context.kind === "app" ? context.nonce : undefined;
  const sentDomain = emailDomain(sentEmail);
  const discovered = discoveredProvider?.domain === sentDomain ? discoveredProvider : null;
  const provider = inboxProviderForDomain(sentDomain) ?? inboxProvider(discovered?.id ?? null);
  const inbox = inboxUrl(provider?.id ?? null, sentEmail);
  // Once the lookup finds no provider, a phone opens its own mail app. The sent step renders
  // only after a send in this browser, so the server never reads navigator here.
  const mailApp =
    step === "sent" && discovered && !provider ? phoneMailApp(navigator.userAgent) : null;
  const inboxAction =
    provider && inbox
      ? { href: inbox, label: `Open ${provider.name} ↗`, newTab: true }
      : mailApp
        ? { href: mailApp, label: "Open your email app ↗", newTab: false }
        : null;
  useEffect(() => {
    if (step === "form" && focusEmail.current) {
      form.current?.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
      focusEmail.current = false;
    }
  }, [step]);
  useEffect(
    () => () => {
      requestVersion.current += 1;
      discovery.current?.abort();
    },
    []
  );

  /** Looks up the inbox while the email sends, so the sent step opens with its button. */
  function discoverInbox(address: string) {
    const domain = emailDomain(address);
    if (inboxProviderForDomain(domain)) return;
    discovery.current?.abort();
    const controller = new AbortController();
    discovery.current = controller;
    fetch(`/api/exomem/access/inbox?domain=${encodeURIComponent(domain)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!controller.signal.aborted)
          setDiscoveredProvider({
            domain,
            id:
              inboxProvider(typeof body?.providerId === "string" ? body.providerId : null)?.id ??
              null,
          });
      })
      // A failed lookup settles as unknown; the inbox button is only a shortcut.
      .catch(() => {
        if (!controller.signal.aborted) setDiscoveredProvider({ domain, id: null });
      });
  }
  useEffect(() => {
    if ((step !== "sent" && step !== "limited") || !sentEmail) return;
    const version = requestVersion.current;
    const controller = new AbortController();
    let timer = 0;
    let checking = false;
    async function check() {
      window.clearTimeout(timer);
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const response = await fetch("/api/exomem/access/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedEmail: sentEmail, ...(formNonce ? { formNonce } : {}) }),
          credentials: "same-origin",
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        const body = response.ok ? await response.json() : null;
        if (
          !controller.signal.aborted &&
          version === requestVersion.current &&
          body?.authenticated === true &&
          typeof body.destination === "string"
        ) {
          window.location.replace(body.destination);
          return;
        }
      } catch {
        /* A later authoritative read can recover a missed tab notification. */
      } finally {
        checking = false;
      }
      if (!controller.signal.aborted) timer = window.setTimeout(check, 3_000);
    }
    const wake = (event: StorageEvent) => {
      if (event.key === EXOMEM_SIGN_IN_EVENT_KEY) void check();
    };
    window.addEventListener("storage", wake);
    void check();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener("storage", wake);
    };
  }, [step, sentEmail, formNonce, sentVersion]);
  useEffect(() => {
    if (step !== "unreachable") return;
    let active = true;
    let timer = 0;
    let delay = 8;
    let remaining = delay;
    const tick = async () => {
      remaining -= 1;
      if (remaining <= 0) {
        try {
          const response = await fetch("/healthz", {
            cache: "no-store",
            signal: AbortSignal.timeout(5000),
          });
          const body = await response.json();
          if (active && response.ok && body?.ok === true) {
            setFocusStep(true);
            setStep("form");
            setFailure(null);
            return;
          }
        } catch {
          /* The next bounded read can recover the form. */
        }
        delay = Math.min(60, delay * 2);
        remaining = delay;
      }
      if (active) {
        setRetryIn(remaining);
        timer = window.setTimeout(tick, 1000);
      }
    };
    timer = window.setTimeout(tick, 1000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [step, retryAttempt]);
  useEffect(() => {
    if ((step !== "sent" && step !== "limited") || waitLeft <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(1000, waitLeft));
    return () => window.clearTimeout(timer);
  }, [step, waitLeft]);

  async function send() {
    if (sending) return;
    const version = ++requestVersion.current;
    const address = email;
    setSending(true);
    discoverInbox(address);
    let outcome: StartOutcome;
    try {
      const token = await challengeToken();
      if (version !== requestVersion.current) return;
      outcome = await requestStart(address, token);
    } catch (error) {
      outcome = { kind: error instanceof ChallengeError ? "challenge_failed" : "failed" };
    }
    if (version !== requestVersion.current) return;
    resetChallenge();
    setSending(false);
    if (outcome.kind === "sent") {
      setFailure(null);
      setSentEmail(address);
      setSentVersion(version);
      const at = Date.now();
      setRetryAt(at + outcome.retryAfterSeconds * 1000);
      setNow(at);
      setShownNotice(null);
      setFocusStep(true);
      setStep(outcome.retryLimited ? "limited" : "sent");
      return;
    }
    // Both steps hold the widget, so retry failures can keep the control focused.
    if (outcome.kind === "failed") {
      setRetryIn(8);
      setRetryAttempt((attempt) => attempt + 1);
      setFocusStep(true);
      setStep("unreachable");
    } else {
      setSentVersion(version);
      setFailure(failureCopy.challenge);
    }
  }

  function changeAddress() {
    requestVersion.current += 1;
    focusEmail.current = true;
    setSending(false);
    setFailure(null);
    setFocusStep(false);
    setStep("form");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.querySelector<HTMLInputElement>("input:invalid")?.focus();
      return;
    }
    void send();
  }

  const heading = context.kind === "web" ? startCopy.web : startCopy.app(context.app);

  if (step === "reviewer") {
    return (
      <ReviewerSignIn
        context={context}
        frame={frame}
        onBack={() => {
          setFailure(null);
          setFocusStep(true);
          setStep("form");
        }}
      />
    );
  }

  return (
    <JourneyPage
      kind={step === "unreachable" ? "stop" : "quiet"}
      app={frame.app}
      footer={frame.footer}
      stepKey={step}
      focusHeading={focusStep}
    >
      {step === "unreachable" ? (
        <>
          <StepHeading
            title="We can’t reach Exomem"
            lede="Your connection or our server stopped answering. Nothing you did is lost."
          />
          <div className={styles.group}>
            {challenge}
            <StepNotice>
              Trying again in {retryIn}
              {"\u00a0"}s.
              {statusPageUrl ? " If it keeps happening, our status page says why." : null}
            </StepNotice>
          </div>
          <StepActions
            primary={{
              label: sending ? "Trying…" : "Try now",
              working: sending,
              onClick: () => void send(),
            }}
            secondary={
              statusPageUrl
                ? {
                    label: breakCopy.connectError.statusPage,
                    onClick: () => openElsewhere(statusPageUrl),
                  }
                : null
            }
          />
        </>
      ) : step === "limited" ? (
        <>
          <StepHeading
            title="That’s enough links for now"
            lede="Use the latest email you received, or check your spam folder. You can request another email when the wait ends."
          />
          <div className={styles.group}>
            {challenge}
            <StepNotice alert={!!failure}>
              {failure ??
                (waitLeft > 0
                  ? `You can ask for another in ${clock(waitLeft)}. Not there? Look in spam.`
                  : "You can ask for another now. Not there? Look in spam.")}
            </StepNotice>
          </div>
          <StepActions
            primary={{
              label: resendLabel,
              working: sending,
              disabled: waitLeft > 0,
              onClick: () => void send(),
            }}
            secondary={{ label: sentCopy.differentEmail, onClick: changeAddress }}
          />
        </>
      ) : step === "sent" ? (
        <>
          <StepHeading title={sentCopy.title} lede={sentCopy.lede} />
          <div className={styles.group}>
            <SentCard
              email={sentEmail}
              app={context.kind === "app" ? context.app : undefined}
              onChange={changeAddress}
            />
            {challenge}
          </div>
          <StepNotice alert visible={!!failure}>
            {failure ?? failureCopy.generic}
          </StepNotice>
          <div className={styles.actions}>
            {inboxAction && (
              <div className={styles.primary}>
                {/* A web inbox opens in a new tab. The phone's mail app opens from this tab,
                    which stays and still moves on by itself. */}
                <ButtonLink
                  variant="primary"
                  size="page"
                  href={inboxAction.href}
                  {...(inboxAction.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                >
                  {inboxAction.label}
                </ButtonLink>
              </div>
            )}
            <div className={inboxAction ? undefined : styles.primary}>
              <Button
                variant={inboxAction ? "ghost" : "primary"}
                size="page"
                disabled={waitLeft > 0}
                working={sending}
                onClick={() => void send()}
              >
                {resendLabel}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <StepHeading title={heading.title} lede={heading.lede} />
          {shownNotice ? (
            <StepNotice attention={shownNotice.attention}>{shownNotice.text}</StepNotice>
          ) : null}
          <form ref={form} className={styles.form} onSubmit={submit} noValidate>
            <div className={styles.group}>
              <TextField
                surface="page"
                label={startCopy.emailLabel}
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFailure(null);
                  void startChallenge();
                }}
                error={failure ?? undefined}
              />
              {challenge}
            </div>
            <StepActions
              primaryType="submit"
              primary={{
                label: sending ? "Sending…" : heading.primary,
                working: sending,
                onClick: () => {},
              }}
            />
          </form>
          {reviewerEnabled ? (
            <button
              type="button"
              className={`${styles.reviewerLink} ${phone.hitArea}`}
              onClick={() => {
                setFailure(null);
                setStep("reviewer");
              }}
            >
              {startCopy.reviewerLink}
            </button>
          ) : null}
        </>
      )}
    </JourneyPage>
  );
}

/**
 * App-directory reviewers sign in with the username and password from the submission.
 * One generic failure, which never says which part was wrong.
 */
function ReviewerSignIn({
  context,
  frame,
  onBack,
}: {
  context: StartContext;
  frame: StartFlowProps["frame"];
  onBack: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.querySelector<HTMLInputElement>("input:invalid")?.focus();
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    let destination: string | null = null;
    try {
      const response = await fetch("/api/exomem/access/reviewer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          context.kind === "app"
            ? { username, password, nonce: context.nonce }
            : { username, password }
        ),
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as { destination?: unknown } | null;
      if (response.ok && typeof body?.destination === "string") destination = body.destination;
    } catch {
      destination = null;
    }
    if (destination) {
      window.location.assign(destination);
      return;
    }
    setFailed(true);
    setSubmitting(false);
  }

  const failure =
    context.kind === "app"
      ? reviewerCopy.failedInApp(context.app, context.requestLife)
      : reviewerCopy.failedOnWeb;
  return (
    <JourneyPage kind="quiet" app={frame.app} footer={frame.footer} stepKey="reviewer" focusHeading>
      <StepHeading
        title={reviewerCopy.title}
        lede={
          <>
            {reviewerCopy.lede}
            <span className={styles.reviewerNoteInLede}> {reviewerCopy.note}</span>
          </>
        }
      />
      <form className={styles.form} onSubmit={signIn} noValidate>
        <div className={styles.fields}>
          <TextField
            surface="page"
            label={reviewerCopy.username}
            autoComplete="username"
            spellCheck={false}
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <TextField
            surface="page"
            label={reviewerCopy.password}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            invalid={failed}
            error={failed ? failure : undefined}
            onChange={(event) => {
              setPassword(event.target.value);
              setFailed(false);
            }}
          />
        </div>
        <StepActions
          primaryType="submit"
          primary={{ label: reviewerCopy.primary, working: submitting, onClick: () => {} }}
          secondary={{ label: reviewerCopy.back, onClick: onBack }}
        />
      </form>
      <div className={`${styles.reviewerNote} ${styles.reviewerNoteApart}`}>
        {reviewerCopy.note}
      </div>
    </JourneyPage>
  );
}
