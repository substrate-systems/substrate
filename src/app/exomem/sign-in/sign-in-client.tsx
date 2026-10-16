"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { TextField } from "@/components/exomem/TextField";
import {
  HostedBrowserError,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import styles from "../_journey/journey.module.css";
import { failureCopy, startCopy } from "../_journey/copy";
import { JourneyPage } from "../_journey/JourneyPage";
import { StepActions, StepHeading } from "../_journey/parts";
import { StartFlow } from "../_journey/start-flow";
import { AccessRecovery } from "./recovery";

/** Shown to a screen reader while the link from the email signs the browser in. */
const SIGNING_IN = "Signing you in…";

const CONFIRM = {
  title: "Open your Exomem.",
  lede: "Continue only if you requested this sign-in link.",
  emailLede:
    "Continue only if you requested this sign-in link. Enter the email address you used to request it.",
  primary: "Continue sign-in",
};

type Mode =
  | "checking"
  | "confirm"
  | "redeeming"
  | "form"
  | "unusable"
  | "failed"
  | "expired"
  | "used";

/**
 * "Start with your email", and the page the email's link opens. The link carries its
 * token in the fragment, which never reaches a server log; the page takes it out of
 * the address bar first, and redeems it only when the person presses Continue.
 */
export default function SignInClient({ reviewerEnabled }: { reviewerEnabled: boolean }) {
  const started = useRef(false);
  const token = useRef<string | null>(null);
  const [mode, setMode] = useState<Mode>("checking");
  const [emailRequired, setEmailRequired] = useState(false);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);

  useEffect(() => {
    const takeLink = () => {
      token.current = takeFragmentToken();
      if (token.current) {
        setEmailRequired(false);
        setEmail("");
        setEmailError(null);
        setMode("confirm");
      }
      return token.current !== null;
    };
    if (!started.current) {
      started.current = true;
      if (!takeLink()) setMode("form");
    }
    // A link pasted into this tab while it is open changes only the fragment: the page
    // does not load again, so it takes the new link here.
    window.addEventListener("hashchange", takeLink);
    return () => window.removeEventListener("hashchange", takeLink);
  }, []);

  function redeem() {
    if (!token.current || mode !== "confirm") return;
    setMode("redeeming");
    postPublicJson("/api/exomem/access/magic-link/redeem", {
      token: token.current,
      ...(emailRequired ? { expectedEmail: email } : {}),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      emailScheme: document.documentElement.getAttribute("data-theme"),
    })
      .then((result) => {
        token.current = null;
        window.location.replace(
          typeof result.destination === "string" ? result.destination : "/exomem/home"
        );
      })
      .catch((error) => {
        if (error instanceof HostedBrowserError) {
          if (error.code === "EMAIL_CONFIRMATION_REQUIRED") {
            setEmailRequired(true);
            setMode("confirm");
            return;
          }
          if (
            emailRequired &&
            (error.code === "ACCESS_TOKEN_INVALID" || error.code === "INVALID_EMAIL")
          ) {
            setEmailError(
              "We couldn’t sign you in. Check your email address or request a new link."
            );
            setMode("confirm");
            return;
          }
        }
        setMode(
          error instanceof HostedBrowserError && error.code === "ACCESS_LINK_EXPIRED"
            ? "expired"
            : error instanceof HostedBrowserError && error.code === "ACCESS_LINK_USED"
              ? "used"
              : error instanceof HostedBrowserError && error.code === "ACCESS_TOKEN_INVALID"
                ? "unusable"
                : "failed"
        );
      });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) {
      event.currentTarget.querySelector<HTMLInputElement>("input:invalid")?.focus();
      return;
    }
    redeem();
  }

  if (mode === "expired" || mode === "used")
    return <AccessRecovery state={mode} onChangeAddress={() => setMode("form")} />;

  if (mode === "checking") {
    return <JourneyPage kind="hold" stepKey="checking" />;
  }
  if (mode === "confirm" || mode === "redeeming") {
    return (
      <JourneyPage
        kind={mode === "redeeming" ? "hold" : "quiet"}
        stepKey={emailRequired ? "email" : "confirm"}
        focusHeading={emailRequired}
      >
        <StepHeading
          title={CONFIRM.title}
          lede={emailRequired ? CONFIRM.emailLede : CONFIRM.lede}
        />
        {emailRequired ? (
          <form className={styles.form} onSubmit={submit} noValidate>
            <TextField
              surface="page"
              label={startCopy.emailLabel}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              maxLength={254}
              data-step-focus
              value={email}
              disabled={mode === "redeeming"}
              onChange={(event) => {
                setEmail(event.target.value);
                setEmailError(null);
              }}
              error={emailError ?? undefined}
            />
            <StepActions
              primaryType="submit"
              primary={{
                label: mode === "redeeming" ? SIGNING_IN : CONFIRM.primary,
                working: mode === "redeeming",
                onClick: () => {},
              }}
              secondary={{
                label: "Request a new link",
                onClick: () => setMode("form"),
                disabled: mode === "redeeming",
              }}
            />
          </form>
        ) : (
          <StepActions
            primary={{
              label: mode === "redeeming" ? SIGNING_IN : CONFIRM.primary,
              working: mode === "redeeming",
              onClick: redeem,
            }}
          />
        )}
      </JourneyPage>
    );
  }
  return (
    <StartFlow
      focusHeading={mode !== "form"}
      context={{ kind: "web" }}
      reviewerEnabled={reviewerEnabled}
      frame={{}}
      notice={
        mode === "form"
          ? null
          : {
              text: mode === "unusable" ? failureCopy.linkUnusable : failureCopy.generic,
              attention: true,
            }
      }
    />
  );
}
