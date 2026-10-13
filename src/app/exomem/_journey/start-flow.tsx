"use client";

import { useEffect, useState, type FormEvent } from "react";
import { TextField } from "@/components/exomem/TextField";
import { failureCopy, reviewerCopy, sentCopy, startCopy } from "./copy";
import { JourneyPage, type AppTile } from "./JourneyPage";
import { SentCard, StepActions, StepHeading, StepNotice } from "./parts";
import { ChallengeError, useTurnstile } from "./turnstile";
import phone from "@/components/exomem/phone.module.css";
import styles from "./journey.module.css";

/**
 * How long "Try again" waits after a send. The server's limit is silent by
 * design (every request answers the same 202), so without a wait an impatient person
 * spends the hourly allowance with nothing to show for it. This is not a security
 * control; the server enforces the real limit.
 */
const RESEND_WAIT_MS = 60_000;

type StartContext =
  | { kind: "web" }
  /** An app's consent page: the reviewer sign-in binds to its request with the form nonce. */
  | { kind: "app"; app: string; nonce: string; requestLife: string };

/** Configuration: Cloudflare's test site key locally and in tests, the real one in production. */
const SITE_KEY = process.env.NEXT_PUBLIC_EXOMEM_TURNSTILE_SITE_KEY?.trim() || null;

type StartFlowProps = {
  context: StartContext;
  reviewerEnabled: boolean;
  /** The frame the page draws around the steps. */
  frame: { app?: AppTile; footer?: string | null };
  /** A notice to show over the form when it first appears (signed out, a spent link). */
  notice?: { text: string; attention: boolean } | null;
  focusHeading?: boolean;
};

type StartOutcome = "sent" | "challenge_failed" | "failed";

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
      }),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return "failed";
  }
  if (response.status === 202) return "sent";
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return response.status === 400 && body?.error === "challenge_failed"
    ? "challenge_failed"
    : "failed";
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Start with your email, check your email, and the reviewer sign-in beside them. */
export function StartFlow({
  context,
  reviewerEnabled,
  frame,
  notice,
  focusHeading = false,
}: StartFlowProps) {
  const [step, setStep] = useState<"form" | "sent" | "reviewer">("form");
  const [focusStep, setFocusStep] = useState(focusHeading);
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [shownNotice, setShownNotice] = useState(notice ?? null);
  const [sentAt, setSentAt] = useState(0);
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

  const waitLeft = sentAt + RESEND_WAIT_MS - now;
  useEffect(() => {
    if (step !== "sent" || waitLeft <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(1000, waitLeft));
    return () => window.clearTimeout(timer);
  }, [step, waitLeft]);

  async function send() {
    if (sending) return;
    setSending(true);
    let outcome: StartOutcome;
    try {
      outcome = await requestStart(email, await challengeToken());
    } catch (error) {
      outcome = error instanceof ChallengeError ? "challenge_failed" : "failed";
    }
    resetChallenge();
    setSending(false);
    if (outcome === "sent") {
      setFailure(null);
      const at = Date.now();
      setSentAt(at);
      setNow(at);
      setShownNotice(null);
      setFocusStep(true);
      setStep("sent");
      return;
    }
    // Both steps hold the widget, so retry failures can keep the control focused.
    setFailure(outcome === "challenge_failed" ? failureCopy.challenge : failureCopy.generic);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      kind="quiet"
      app={frame.app}
      footer={frame.footer}
      stepKey={step}
      focusHeading={focusStep}
    >
      {step === "sent" ? (
        <>
          <StepHeading title={sentCopy.title} lede={sentCopy.lede} />
          <div className={styles.group}>
            <SentCard email={email} />
            {challenge}
          </div>
          <StepNotice alert visible={!!failure}>
            {failure ?? failureCopy.generic}
          </StepNotice>
          <StepActions
            primary={{
              label: sending
                ? "Sending…"
                : waitLeft > 0
                  ? sentCopy.resendIn(clock(waitLeft))
                  : sentCopy.resend,
              disabled: waitLeft > 0,
              working: sending,
              onClick: () => void send(),
            }}
            secondary={{
              label: sentCopy.differentEmail,
              onClick: () => {
                setFocusStep(true);
                setStep("form");
              },
            }}
          />
        </>
      ) : (
        <>
          <StepHeading title={heading.title} lede={heading.lede} />
          {shownNotice ? (
            <StepNotice attention={shownNotice.attention}>{shownNotice.text}</StepNotice>
          ) : null}
          <form className={styles.form} onSubmit={submit}>
            <div className={styles.group}>
              <TextField
                label={startCopy.emailLabel}
                type="email"
                name="email"
                autoComplete="email"
                inputMode="email"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  void startChallenge();
                }}
                error={failure ?? undefined}
                errorSpace={failureCopy.generic}
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
    setPassword("");
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
      <StepNotice alert id="reviewer-failure" visible={failed}>
        {failure}
      </StepNotice>
      <form className={styles.form} onSubmit={signIn}>
        <div className={styles.fields}>
          <TextField
            label={reviewerCopy.username}
            autoComplete="username"
            spellCheck={false}
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <TextField
            label={reviewerCopy.password}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            invalid={failed}
            aria-describedby={failed ? "reviewer-failure" : undefined}
            onChange={(event) => setPassword(event.target.value)}
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
