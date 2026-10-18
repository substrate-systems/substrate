"use client";

import { useEffect, useRef, useState } from "react";
import {
  friendlyHostedError,
  HostedBrowserError,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import { JourneyPage } from "../_journey/JourneyPage";
import { StepActions, StepHeading, StepNotice } from "../_journey/parts";

// These states describe this page's fixed capability protocol, not account lifecycle data.
type State = "checking" | "ready" | "submitting" | "complete" | "invalid";

export default function EmailChangeClient({ action }: { action: "confirm" | "cancel" }) {
  const started = useRef(false);
  const token = useRef<string | null>(null);
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    token.current = takeFragmentToken();
    queueMicrotask(() => setState(token.current ? "ready" : "invalid"));
  }, []);

  async function complete() {
    if (state !== "ready" || !token.current) return;
    setError(null);
    setState("submitting");
    try {
      const response = await postPublicJson(`/api/exomem/account/email-change/${action}`, {
        token: token.current,
      });
      if (response.success !== true || response.state !== (action === "confirm" ? "confirmed" : "cancelled"))
        throw new Error("The email-change result was not confirmed.");
      token.current = null;
      setState("complete");
    } catch (failure) {
      if (failure instanceof HostedBrowserError && failure.code === "ACCESS_TOKEN_INVALID") {
        token.current = null;
        setState("invalid");
      } else {
        setError(friendlyHostedError(failure));
        setState("ready");
      }
    }
  }

  const completed = state === "complete";
  const invalid = state === "invalid";
  const title = state === "checking"
    ? "Checking this link"
    : invalid
      ? "This link no longer works"
      : completed
        ? action === "confirm" ? "Your email has changed" : "Email change stopped"
        : action === "confirm" ? "Confirm your new email" : "Stop this email change?";
  const lede = state === "checking"
    ? "Your account stays unchanged until you choose an action."
    : invalid
      ? "This link may have expired, been replaced or already been used. Check Home before requesting another change."
      : completed
        ? action === "confirm"
          ? "New sign-in links go to your new address. Your notes, sessions and connected apps stay with your account."
          : "This pending change is cancelled. Your account still uses its existing email address."
        : action === "confirm"
          ? "Use the new address for Exomem sign-in links. Your notes and connected apps stay as they are."
          : "Keep your current email address. The pending change will no longer work.";

  return (
    <JourneyPage
      kind={completed ? "done" : invalid ? "stop" : "hold"}
      tilesIdle
      stepKey={state}
      focusHeading={state !== "checking"}
    >
      <StepHeading title={title} lede={lede} />
      <StepNotice visible={error !== null} alert>{error}</StepNotice>
      {state !== "checking" ? (
        <StepActions
          primary={completed || invalid
            ? { label: "Go to Home", onClick: () => window.location.assign("/exomem/home") }
            : {
                label: action === "confirm" ? "Confirm this address" : "Stop the change",
                working: state === "submitting",
                onClick: () => void complete(),
              }}
        />
      ) : null}
      {/* One explicit action prevents a link preview from changing the account; it costs its owner one click. */}
    </JourneyPage>
  );
}
