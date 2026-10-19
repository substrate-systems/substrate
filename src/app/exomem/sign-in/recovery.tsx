"use client";

import { useEffect, useState } from "react";
import { postPublicJson } from "@/lib/exomem-hosted/hosted-browser";
import { OWNER_SIGN_IN_TTL_MS } from "@/lib/exomem/access-limits";
import { JourneyPage } from "../_journey/JourneyPage";
import { failureCopy, sentCopy } from "../_journey/copy";
import { StepActions, StepHeading, StepNotice } from "../_journey/parts";

/** The proven browser can resend without learning an address from the receipt. */
export function AccessRecovery({ state }: { state: "expired" | "used" }) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    if (!wait) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);
  async function resend() {
    if (busy || wait) return;
    setBusy(true);
    setFailure(false);
    try {
      const result = await postPublicJson("/api/exomem/access/magic-link/recover", {});
      if (
        typeof result.retryAfterSeconds !== "number" ||
        !Number.isInteger(result.retryAfterSeconds) ||
        result.retryAfterSeconds < 0
      )
        throw new Error("Retry timing unavailable");
      const at = Date.now();
      setNow(at);
      setRetryAt(at + result.retryAfterSeconds * 1000);
      setSent(true);
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <JourneyPage kind="quiet" stepKey={sent ? "recovery-sent" : state} focusHeading>
      <StepHeading
        title={
          sent
            ? sentCopy.title
            : state === "expired"
              ? "This link has expired"
              : "This link was already used"
        }
        lede={
          sent
            ? sentCopy.lede
            : state === "expired"
              ? `Sign-in links work once, for ${OWNER_SIGN_IN_TTL_MS / 60_000} minutes.`
              : "Each link works once. If you opened it on another device, you’re signed in there. To sign in here, ask for a new one."
        }
      />
      <StepNotice alert visible={failure}>
        {failureCopy.generic}
      </StepNotice>
      <StepActions
        primary={{
          label: busy
            ? "Sending…"
            : wait
              ? `Email me a new link in ${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}`
              : "Email me a new link",
          working: busy,
          disabled: wait > 0,
          onClick: () => void resend(),
        }}
      />
    </JourneyPage>
  );
}
