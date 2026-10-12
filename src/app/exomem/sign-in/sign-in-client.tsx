"use client";

import { useEffect, useRef, useState } from "react";
import {
  HostedBrowserError,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import { failureCopy } from "../_journey/copy";
import { JourneyPage } from "../_journey/JourneyPage";
import { StepActions, StepHeading, WorkingBar } from "../_journey/parts";
import { StartFlow } from "../_journey/start-flow";

/** Shown to a screen reader while the link from the email signs the browser in. */
const SIGNING_IN = "Signing you in…";

/**
 * The step before a link from the email signs in. The boards go straight from the email
 * to the next step; this keeps the explicit action of the page the journey replaces,
 * with its words unchanged, until the owner decides (listed as a deviation).
 */
const CONFIRM = {
  title: "Open your Exomem.",
  lede: "Continue only if you requested this sign-in link in this browser.",
  primary: "Continue sign-in",
};

type Mode = "checking" | "confirm" | "redeeming" | "form" | "unusable" | "failed";

/**
 * "Start with your email", and the page the email's link opens. The link carries its
 * token in the fragment, which never reaches a server log; the page takes it out of
 * the address bar first, and redeems it in this browser (the one that asked for it)
 * only when the person presses Continue.
 */
export default function SignInClient({ reviewerEnabled }: { reviewerEnabled: boolean }) {
  const started = useRef(false);
  const token = useRef<string | null>(null);
  const [mode, setMode] = useState<Mode>("checking");

  useEffect(() => {
    const takeLink = () => {
      token.current = takeFragmentToken();
      if (token.current) setMode("confirm");
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
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
      .then((result) => {
        token.current = null;
        window.location.replace(
          typeof result.destination === "string" ? result.destination : "/exomem/home"
        );
      })
      .catch((error) =>
        // Links work once, for a limited time, in the browser that asked: a refused
        // token is nearly always spent or late. Anything else is ours.
        setMode(
          error instanceof HostedBrowserError && error.code === "ACCESS_TOKEN_INVALID"
            ? "unusable"
            : "failed"
        )
      );
  }

  if (mode === "checking" || mode === "redeeming") {
    return (
      <JourneyPage kind="hold" stepKey="redeeming">
        {mode === "redeeming" ? <WorkingBar label={SIGNING_IN} /> : null}
      </JourneyPage>
    );
  }
  if (mode === "confirm") {
    return (
      <JourneyPage kind="quiet" stepKey="confirm">
        <StepHeading title={CONFIRM.title} lede={CONFIRM.lede} />
        <StepActions primary={{ label: CONFIRM.primary, onClick: redeem }} />
      </JourneyPage>
    );
  }
  return (
    <StartFlow
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
