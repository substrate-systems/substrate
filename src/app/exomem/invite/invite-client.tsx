"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HostedBrowserError,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import { failureCopy, inviteCopy, TRY_AGAIN } from "../_journey/copy";
import { JourneyPage } from "../_journey/JourneyPage";
import { StepActions, StepHeading, StepNotice, WorkingBar } from "../_journey/parts";

type Mode =
  | { kind: "checking" }
  | { kind: "invite"; failure: string | null }
  | { kind: "accepting" }
  | { kind: "unusable" }
  /** Inspecting failed on our side: the same link may work in a moment. */
  | { kind: "failed" };

// A refused token (expired, used, revoked, malformed) is final: one identical answer
// that names no one. A retryable refusal means Exomem cannot open it right now.
function refused(error: unknown): boolean {
  return error instanceof HostedBrowserError && !error.retryable;
}

/**
 * An invitation link. The token is in the fragment; the page takes it out of the
 * address bar first. Accepting creates the Exomem and signs this browser in; a paid
 * invitation continues at setup, a covered one at Home, and one opened from an app's
 * consent page continues that connection (the redeem route decides).
 */
export default function InviteClient() {
  const token = useRef<string | null>(null);
  const started = useRef(false);
  const [mode, setMode] = useState<Mode>({ kind: "checking" });

  const inspect = useCallback(async () => {
    if (!token.current) return;
    setMode({ kind: "checking" });
    try {
      await postPublicJson("/api/exomem/access/inspect", { token: token.current });
      setMode({ kind: "invite", failure: null });
    } catch (error) {
      setMode({ kind: refused(error) ? "unusable" : "failed" });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    token.current = takeFragmentToken();
    if (!token.current) setMode({ kind: "unusable" });
    else void inspect();
  }, [inspect]);

  async function accept() {
    if (!token.current) return;
    setMode({ kind: "accepting" });
    try {
      const result = await postPublicJson("/api/exomem/access/redeem", {
        token: token.current,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      token.current = null;
      window.location.replace(
        typeof result.destination === "string" ? result.destination : "/exomem/home"
      );
    } catch (error) {
      if (refused(error)) setMode({ kind: "unusable" });
      else setMode({ kind: "invite", failure: failureCopy.invitationNotReady });
    }
  }

  switch (mode.kind) {
    case "checking":
      return <JourneyPage kind="quiet" stepKey="checking" />;
    case "unusable":
      return (
        <JourneyPage kind="quiet" stepKey="unusable">
          <StepHeading title={inviteCopy.unusable.title} lede={inviteCopy.unusable.lede} />
          <StepActions
            primary={{
              label: inviteCopy.unusable.primary,
              onClick: () => window.location.assign("/exomem/sign-in"),
            }}
          />
        </JourneyPage>
      );
    case "failed":
      return (
        <JourneyPage kind="quiet" stepKey="failed">
          <StepNotice alert>{failureCopy.generic}</StepNotice>
          <StepActions primary={{ label: TRY_AGAIN, onClick: () => void inspect() }} />
        </JourneyPage>
      );
    case "accepting":
      return (
        <JourneyPage kind="hold" stepKey="accepting">
          <StepHeading title={inviteCopy.accepting.title} lede={inviteCopy.accepting.lede} />
          <WorkingBar label={inviteCopy.accepting.title} />
        </JourneyPage>
      );
    case "invite":
      return (
        <JourneyPage kind="quiet" stepKey="invite">
          <StepHeading title={inviteCopy.standardTitle} lede={inviteCopy.lede} />
          {mode.failure ? <StepNotice alert>{mode.failure}</StepNotice> : null}
          <StepActions primary={{ label: inviteCopy.accept, onClick: () => void accept() }} />
        </JourneyPage>
      );
  }
}
