"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { takeFragmentToken } from "@/lib/exomem-hosted/hosted-browser";
import { UNSUBSCRIBE_POST_PATH } from "@/lib/exomem-hosted/whats-new-digest/unsubscribe-paths";
import { JourneyPage } from "../../_journey/JourneyPage";
import { StepActions, StepHeading, StepNotice } from "../../_journey/parts";

// These states describe this page's fixed protocol, not account data.
type State = "checking" | "ready" | "submitting" | "done" | "invalid";

/**
 * Opened from the link in a digest email. Opening it changes nothing: the
 * button sends the same POST that a mail client's one-click unsubscribe sends
 * (RFC 8058), so a link preview or scanner cannot turn the email off.
 */
export default function UnsubscribeClient() {
  const router = useRouter();
  const started = useRef(false);
  const token = useRef<string | null>(null);
  const [state, setState] = useState<State>("checking");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    token.current = takeFragmentToken();
    queueMicrotask(() => setState(token.current ? "ready" : "invalid"));
  }, []);

  async function turnOff() {
    if (state !== "ready" || !token.current) return;
    setFailed(false);
    setState("submitting");
    try {
      const response = await fetch(
        `${UNSUBSCRIBE_POST_PATH}?token=${encodeURIComponent(token.current)}`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        }
      );
      if (response.ok) {
        token.current = null;
        setState("done");
      } else if (response.status === 401) {
        token.current = null;
        setState("invalid");
      } else {
        setFailed(true);
        setState("ready");
      }
    } catch {
      setFailed(true);
      setState("ready");
    }
  }

  const title =
    state === "checking"
      ? "Checking this link"
      : state === "invalid"
        ? "This link no longer works"
        : state === "done"
          ? "Monthly update email is off"
          : "Turn off the monthly update email?";

  return (
    <JourneyPage
      kind={state === "done" ? "done" : state === "invalid" ? "stop" : "hold"}
      tilesIdle
      stepKey={state}
      focusHeading={state !== "checking"}
    >
      <StepHeading title={title} />
      <StepNotice visible={failed} alert>
        That did not go through. Try again in a moment.
      </StepNotice>
      {state === "ready" || state === "submitting" ? (
        <StepActions
          primary={{
            label: "Turn off the monthly email",
            working: state === "submitting",
            onClick: () => void turnOff(),
          }}
        />
      ) : state === "done" || state === "invalid" ? (
        <StepActions
          primary={{ label: "Go to Home", onClick: () => router.push("/exomem/home") }}
        />
      ) : null}
    </JourneyPage>
  );
}
