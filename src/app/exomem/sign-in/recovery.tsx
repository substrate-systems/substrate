"use client";

import { useEffect, useState } from "react";
import { postPublicJson } from "@/lib/exomem-hosted/hosted-browser";
import { OWNER_SIGN_IN_TTL_MS, START_LIMITS, type StartLimit } from "@/lib/exomem/access-limits";
import { JourneyPage } from "../_journey/JourneyPage";
import { failureCopy, limitedCopy, resendWait, sentCopy, waitInWords } from "../_journey/copy";
import { StepActions, StepHeading, StepNotice } from "../_journey/parts";

/** The proven browser can resend without learning an address from the receipt. */
export function AccessRecovery({ state }: { state: "expired" | "used" }) {
  const [sent, setSent] = useState(false);
  // The limit that refused the resend, so no email went out; null when one was sent.
  const [limitedBy, setLimitedBy] = useState<StartLimit | null>(null);
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
      setLimitedBy(START_LIMITS.find((limit) => limit === result.limitedBy) ?? null);
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
            ? limitedBy
              ? limitedCopy.title[limitedBy]
              : sentCopy.title
            : state === "expired"
              ? "This link has expired"
              : "This link was already used"
        }
        lede={
          sent
            ? limitedBy
              ? `${limitedCopy.lede[limitedBy]} ${wait > 0 ? limitedCopy.wait(waitInWords(wait)) : limitedCopy.nowAllowed}`
              : sentCopy.ledeWithoutAddress
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
              ? `Email me a new link ${resendWait(wait)}`
              : "Email me a new link",
          working: busy,
          disabled: wait > 0,
          onClick: () => void resend(),
        }}
      />
    </JourneyPage>
  );
}
