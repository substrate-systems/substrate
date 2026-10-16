"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { FieldKind } from "@/components/exomem/FlowField";
import { CheckoutInline } from "@/components/exomem/CheckoutInline";
import type { Known } from "@/lib/exomem-hosted/known";
import { openBillingPortal, signOut } from "../_journey/account-actions";
import {
  breakCopy,
  consentCopy,
  failureCopy,
  handbackCopy,
  startCopy,
  UNNAMED_APP,
} from "../_journey/copy";
import { returnToWebApp, tellLoopbackApp } from "../_journey/handback";
import { appTile, JourneyPage } from "../_journey/JourneyPage";
import {
  DoneLine,
  EndedActions,
  endedLede,
  openElsewhere,
  ScopesCard,
  SignedInLine,
  StepActions,
  StepHeading,
  StepNotice,
} from "../_journey/parts";
import { useReaderDate } from "../_journey/reader-date";
import { StartFlow } from "../_journey/start-flow";
import styles from "../_journey/journey.module.css";
import { offerInviter, type FriendOffer } from "../home/home-view";
import { offersConnect, type ConsentScreen } from "./consent-screen";

export type AccountFacts = {
  tenantId: string | null;
  readOnlyUntil: Known<string>;
  keptUntil: Known<string>;
  supportReference: Known<string>;
  /** The account's friend offer, which checkout applies; null when the account is unknown. */
  friendOffer: FriendOffer | null;
  /** Whether checkout can start now, as Home's billing summary says; false when unknown. */
  checkoutAvailable: boolean;
};

export type RequestApp = {
  displayName: string;
  /** Exomem stands behind the name (operator or platform), so it needs no label. */
  vouched: boolean;
  platform: string | null;
  loopback: boolean;
  redirectHost: string;
};

/** The footer names the code destination; app-name claims appear beside consent. */
function requestFooter(app: RequestApp): string {
  const from = app.loopback ? consentCopy.onThisComputer(app.displayName) : app.redirectHost;
  return consentCopy.footer(from);
}

type ConsentRequest = {
  app: RequestApp;
  scopes: string[];
  email: string | null;
  confirmation: string;
  nonce: string;
  reviewerEnabled: boolean;
  /** The app's own connector settings, for "Connect after all"; null when not known. */
  connectorSettingsUrl: string | null;
  account: AccountFacts;
  /** The price checkout charges, previewed in the browser; null shows no amount. */
  priceId: string | null;
  /** Whether Home offers an export: the export flag. */
  exportOffered: boolean;
};

type Phase =
  | ConsentScreen
  | "confirming"
  | "connecting"
  | "sealing"
  | "connecterror"
  | "unconfirmed"
  | "handback"
  | "declined"
  | "kept"
  | "switched";

// kindOf() in the board: what the field and the tiles show for each step.
const KIND: Record<Phase, FieldKind> = {
  expired: "stop",
  ended: "stop",
  paused: "stop",
  suspended: "stop",
  connecterror: "stop",
  unconfirmed: "hold",
  signedout: "quiet",
  switched: "quiet",
  subscribe: "quiet",
  declined: "quiet",
  confirming: "hold",
  connect: "live",
  again: "live",
  preparing: "live",
  readonly: "live",
  connecting: "go",
  sealing: "done",
  handback: "done",
  kept: "quiet",
};

// The board repeats the signed-in email under the actions on a desktop only here.
const SIGNED_IN_ON_DESKTOP: Phase[] = [
  "connect",
  "again",
  "preparing",
  "readonly",
  "subscribe",
  "connecterror",
];
const SIGNED_OUT: Phase[] = ["expired", "signedout", "switched"];

type Outcome = { redirectUrl: string; loopback: boolean };

function outcomeOf(body: unknown): Outcome | null {
  if (!body || typeof body !== "object") return null;
  const { redirectUrl, loopback } = body as Record<string, unknown>;
  return typeof redirectUrl === "string" ? { redirectUrl, loopback: loopback === true } : null;
}

async function postJson(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
}

/**
 * Whether the answer proves that nothing changed. Only a 400 does: the complete route
 * sends every 400 before any write, and a 400 from anything in between means the
 * request never reached the route. Any other answer leaves the outcome unknown,
 * including the route's own 500, which can follow a committed attach whose
 * acknowledgement was lost.
 */
function nothingChanged(answer: { status: number }): boolean {
  return answer.status === 400;
}

function consentPathOf(body: unknown): string | null {
  const path = (body as { consentPath?: unknown } | null)?.consentPath;
  return typeof path === "string" && path.startsWith("/exomem/authorize") ? path : null;
}

export default function AuthorizeClient({
  screen,
  request,
  expiredApp = null,
  requestLife,
  statusPageUrl,
}: {
  screen: ConsentScreen;
  request: ConsentRequest | null;
  /**
   * Without a live request: the app this browser's request was from, when known. Unknown,
   * the step says "your app" and draws no app (design.md (ae)).
   */
  expiredApp?: RequestApp | null;
  requestLife: string;
  statusPageUrl: string | null;
}) {
  if (!request) {
    return (
      <JourneyPage
        kind="stop"
        app={expiredApp ? appTile(expiredApp) : undefined}
        footer={expiredApp ? requestFooter(expiredApp) : null}
        stepKey="expired"
      >
        <StepHeading
          title={breakCopy.expired.title}
          lede={breakCopy.expired.lede(requestLife, expiredApp?.displayName ?? UNNAMED_APP)}
        />
      </JourneyPage>
    );
  }
  return (
    <Consent
      screen={screen}
      request={request}
      requestLife={requestLife}
      statusPageUrl={statusPageUrl}
    />
  );
}

function Consent({
  screen,
  request,
  requestLife,
  statusPageUrl,
}: {
  screen: ConsentScreen;
  request: ConsentRequest;
  requestLife: string;
  statusPageUrl: string | null;
}) {
  const { app, confirmation, nonce, account } = request;
  const name = app.displayName;
  const [focusHeading, setFocusHeading] = useState(false);
  const [phase, setPhase] = useState<Phase>(screen);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<"declined" | "kept" | "billing" | null>(null);
  const motion = useRef<Partial<Record<"connecting" | "connected", () => void>>>({});
  const onPairMotionComplete = useCallback((state: "connecting" | "connected") => {
    motion.current[state]?.();
    delete motion.current[state];
  }, []);
  const readOnlyUntil = useReaderDate(account.readOnlyUntil);
  const keptUntil = useReaderDate(account.keptUntil);

  // The app hears the answer: a web app by a navigation after the page has shown it,
  // an app on this computer in the background while the page stays.
  useEffect(() => {
    if (!outcome || (phase !== "handback" && phase !== "declined" && phase !== "kept")) return;
    if (outcome.loopback) {
      void tellLoopbackApp(outcome.redirectUrl);
      return;
    }
    return returnToWebApp(outcome.redirectUrl);
  }, [outcome, phase]);

  const current = phase;
  const inviter = offerInviter(account.friendOffer);

  async function connect(event?: FormEvent<HTMLFormElement>) {
    // Without JavaScript the form posts itself and the server answers with a redirect.
    event?.preventDefault();
    setFailure(null);
    setFocusHeading(true);
    const cycle = new Promise<void>((resolve) => {
      motion.current.connecting = resolve;
    });
    setPhase("connecting");
    let answer: { status: number; body: unknown };
    try {
      answer = await postJson("/api/exomem/oauth/authorize/complete", { confirmation, nonce });
    } catch {
      // The request may have reached the server and connected the app; only the
      // answer was lost.
      setPhase("unconfirmed");
      return;
    }
    const connected = answer.status === 200 ? outcomeOf(answer.body) : null;
    if (connected) {
      await cycle;
      const seal = new Promise<void>((resolve) => {
        motion.current.connected = resolve;
      });
      setOutcome(connected);
      setPhase("sealing");
      await seal;
      setPhase("handback");
      return;
    }
    const fresh = answer.status === 409 ? consentPathOf(answer.body) : null;
    if (fresh) window.location.replace(fresh);
    else if (answer.status === 410) setPhase("expired");
    else setPhase(nothingChanged(answer) ? "connecterror" : "unconfirmed");
  }

  async function decline(kind: "declined" | "kept") {
    if (busy) return;
    setFocusHeading(true);
    setBusy(kind);
    setFailure(null);
    let answer: { status: number; body: unknown } | null = null;
    try {
      answer = await postJson("/api/exomem/oauth/authorize/decline", {
        confirmation,
        nonce,
        outcome: kind,
      });
    } catch {
      answer = null;
    }
    setBusy(null);
    const ended = answer?.status === 200 ? outcomeOf(answer.body) : null;
    if (ended) {
      setOutcome(ended);
      setPhase(kind);
      return;
    }
    const fresh = answer?.status === 409 ? consentPathOf(answer.body) : null;
    if (fresh) window.location.replace(fresh);
    else if (answer?.status === 410) setPhase("expired");
    else setFailure(failureCopy.generic);
  }

  async function fixBilling() {
    setBusy("billing");
    if (!(await openBillingPortal())) {
      setBusy(null);
      setFailure(failureCopy.generic);
    }
  }

  async function switchAccount() {
    setFocusHeading(true);
    if (await signOut()) setPhase("switched");
    else setFailure(failureCopy.generic);
  }

  const tile = appTile(app);
  const footer = requestFooter(app);
  const claimedName = !app.vouched && !app.loopback ? app.displayName : null;

  if (current === "signedout" || current === "switched") {
    return (
      <StartFlow
        focusHeading={current === "switched"}
        context={{ kind: "app", app: name, nonce, requestLife }}
        reviewerEnabled={request.reviewerEnabled}
        frame={{ app: tile, footer }}
        notice={
          current === "switched" && request.email
            ? { text: startCopy.switched(request.email), attention: false }
            : null
        }
      />
    );
  }

  if ((current === "subscribe" || current === "confirming") && request.email) {
    return (
      <CheckoutInline
        email={request.email}
        tenantId={request.account.tenantId}
        inviter={inviter}
        onReady={() => window.location.reload()}
      />
    );
  }

  const signedIn = !SIGNED_OUT.includes(current) && request.email ? request.email : null;
  const signedInLine = signedIn ? (
    <SignedInLine
      email={signedIn}
      onSwitch={() => void switchAccount()}
      onDesktop={SIGNED_IN_ON_DESKTOP.includes(current)}
    />
  ) : null;
  const exportMemory = {
    label: request.exportOffered ? breakCopy.export : breakCopy.home,
    onClick: () => window.location.assign("/exomem/home"),
  };

  let body;
  switch (current) {
    case "expired":
      body = (
        <StepHeading
          title={breakCopy.expired.title}
          lede={breakCopy.expired.lede(requestLife, name)}
        />
      );
      break;
    case "connect":
    case "again":
    case "preparing":
    case "readonly":
    case "connecting": {
      const again = current === "again";
      const readOnly = current === "readonly";
      body = (
        <>
          <StepHeading
            title={again ? consentCopy.again.title(name) : consentCopy.title(name)}
            lede={
              again
                ? consentCopy.again.lede
                : readOnly
                  ? consentCopy.readOnly.lede
                  : consentCopy.lede
            }
          />
          {current === "preparing" ? (
            <StepNotice attention>{consentCopy.preparing}</StepNotice>
          ) : null}
          {readOnly ? (
            <StepNotice>
              {consentCopy.readOnly.notice(
                account.readOnlyUntil.value === null ? null : readOnlyUntil
              )}
            </StepNotice>
          ) : null}
          <ScopesCard scopes={request.scopes} readOnly={readOnly} claimedName={claimedName} />
          <StepNotice alert visible={!!failure}>
            {failure ?? failureCopy.generic}
          </StepNotice>
          <form
            className={styles.form}
            action="/api/exomem/oauth/authorize/complete"
            method="post"
            onSubmit={(event) => void connect(event)}
          >
            <input name="nonce" type="hidden" value={nonce} />
            <input name="confirmation" type="hidden" value={confirmation} />
            <StepActions
              primaryType="submit"
              primary={{
                label:
                  current === "connecting"
                    ? consentCopy.connecting
                    : again
                      ? consentCopy.again.primary
                      : consentCopy.connect,
                working: current === "connecting",
                disabled: busy !== null,
                onClick: () => {},
              }}
              secondary={
                current === "connecting"
                  ? null
                  : readOnly
                    ? {
                        label: consentCopy.readOnly.fixBilling,
                        working: busy === "billing",
                        onClick: () => void fixBilling(),
                      }
                    : {
                        label: again ? consentCopy.again.keep : consentCopy.notNow,
                        working: busy === "kept" || busy === "declined",
                        onClick: () => void decline(again ? "kept" : "declined"),
                      }
              }
            />
          </form>
        </>
      );
      break;
    }
    case "connecterror":
      body = (
        <>
          <StepHeading
            title={breakCopy.connectError.title}
            lede={breakCopy.connectError.lede(name)}
          />
          {statusPageUrl ? <StepNotice>{breakCopy.connectError.notice}</StepNotice> : null}
          <ScopesCard scopes={request.scopes} readOnly={false} claimedName={claimedName} />
          <StepActions
            primary={{ label: breakCopy.connectError.retry, onClick: () => void connect() }}
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
      );
      break;
    case "unconfirmed":
      body = (
        <StepHeading
          title={breakCopy.unconfirmed.title(name)}
          lede={breakCopy.unconfirmed.lede(name)}
        />
      );
      break;
    case "sealing":
    case "handback":
      body = (
        <>
          <StepHeading
            title={handbackCopy.title}
            lede={
              outcome?.loopback ? handbackCopy.loopback.lede(name) : handbackCopy.web.lede(name)
            }
          />
          <DoneLine>
            {outcome?.loopback ? handbackCopy.loopback.done(name) : handbackCopy.web.done(name)}
          </DoneLine>
        </>
      );
      break;
    case "declined": {
      // "Connect after all" can no longer resume this request, which is consumed: it
      // opens the app's own connector settings, when Exomem knows where they are.
      const settings = outcome?.loopback ? null : request.connectorSettingsUrl;
      body = (
        <>
          <StepHeading
            title={handbackCopy.declined.title(name)}
            lede={
              outcome?.loopback
                ? handbackCopy.declined.ledeLoopback(name)
                : handbackCopy.declined.lede(name)
            }
          />
          <StepActions
            primary={
              settings
                ? {
                    label: handbackCopy.declined.connectAfterAll,
                    onClick: () => window.location.assign(settings),
                  }
                : null
            }
          />
        </>
      );
      break;
    }
    case "kept":
      body = (
        <>
          <StepHeading title={handbackCopy.kept.title} lede={handbackCopy.kept.lede(name)} />
        </>
      );
      break;
    case "ended":
      body = (
        <>
          <StepHeading
            title={breakCopy.ended.title}
            lede={endedLede({
              until: keptUntil,
              app: name,
              exportOffered: request.exportOffered,
              checkoutAvailable: account.checkoutAvailable,
              inviter,
            })}
          />
          <EndedActions
            resubscribe={
              account.checkoutAvailable
                ? {
                    opening: false,
                    subscribe: async () => {
                      setFocusHeading(true);
                      setPhase("subscribe");
                    },
                  }
                : null
            }
            exportMemory={exportMemory}
          />
        </>
      );
      break;
    case "paused":
      body = (
        <>
          <StepHeading title={breakCopy.paused.title} lede={breakCopy.paused.lede(name)} />
          <StepNotice alert visible={!!failure}>
            {failure ?? failureCopy.generic}
          </StepNotice>
          <StepActions
            primary={{
              label: breakCopy.paused.resume,
              working: busy === "billing",
              onClick: () => void fixBilling(),
            }}
            secondary={exportMemory}
          />
        </>
      );
      break;
    case "suspended":
      body = (
        <>
          <StepHeading
            title={breakCopy.suspended.title}
            lede={
              request.exportOffered
                ? breakCopy.suspended.lede(name)
                : breakCopy.suspended.ledeWithoutExport(name)
            }
          />
          {account.supportReference.value !== null ? (
            <StepNotice>{breakCopy.suspended.notice(account.supportReference.value)}</StepNotice>
          ) : null}
          <StepActions
            primary={{
              label: breakCopy.suspended.contact,
              onClick: () => window.location.assign("/exomem/support"),
            }}
            secondary={exportMemory}
          />
        </>
      );
      break;
  }

  return (
    <JourneyPage
      focusHeading={focusHeading}
      kind={KIND[current]}
      app={tile}
      headerEmail={signedIn}
      footer={footer}
      onPairMotionComplete={onPairMotionComplete}
      // Connect, its variants and Connecting… are one step whose button changes.
      stepKey={
        offersConnect(current as ConsentScreen) || current === "connecting"
          ? "consent"
          : current === "sealing"
            ? "handback"
            : current
      }
    >
      {body}
      {signedInLine}
    </JourneyPage>
  );
}
