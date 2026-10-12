"use client";

import { useCallback, useEffect, useState } from "react";
import { AddressField } from "@/components/exomem/AddressField";
import { subscribeLine } from "@/components/exomem/subscribe-line";
import type { FieldKind } from "@/components/exomem/FlowField";
import { CLIENT_PLATFORM_NAMES } from "@/lib/exomem-hosted/client-platforms";
import { getPrivateJson } from "@/lib/exomem-hosted/hosted-browser";
import type { Known } from "@/lib/exomem-hosted/known";
import { usePaddlePricePreview } from "@/lib/paddle";
import { openBillingPortal, signOut, useCheckout } from "../_journey/account-actions";
import {
  breakCopy,
  chooseCopy,
  failureCopy,
  inviteCopy,
  joinedCopy,
  otherAppCopy,
  startCopy,
  subscribeCopy,
  UNNAMED_APP,
  waitingCopy,
  type PluginApp,
} from "../_journey/copy";
import { JourneyPage } from "../_journey/JourneyPage";
import {
  ChoiceList,
  DoneLine,
  LevelTune,
  openElsewhere,
  SignedInLine,
  StepActions,
  StepHeading,
  StepNotice,
  WaitNote,
  WorkingBar,
  type Choice,
} from "../_journey/parts";
import { useReaderDate } from "../_journey/reader-date";
import { StartFlow } from "../_journey/start-flow";
import { levelContextTitle } from "../home/home-view";
import { joinedSince, pollDelay, type ListedApp } from "./join-rule";
import { useLevelSave } from "./level-save";
import type { SetupScreen } from "./setup-screen";

export type SetupFacts = {
  screen: SetupScreen;
  email: string;
  keptUntil: Known<string>;
  /** "EX-XXXX", quoted to support. */
  supportReference: string;
  /** The Cloud MCP address; null when it is not configured. */
  mcpAddress: string | null;
  /** The assistants' own connector pages; null when not configured. */
  settings: Record<PluginApp, string | null>;
  /** Whether sign-in offers the app reviewer's entry, as the sign-in page does. */
  reviewerEnabled: boolean;
  /** The price checkout charges, previewed in the browser; null shows no amount. */
  priceId: string | null;
  /** Who gave this account its friend offer, which checkout applies; null without one. */
  friendInviter: string | null;
};

type Phase = SetupScreen | "confirming" | "waiting" | "other" | "joined" | "switched";

// kindOf() in the board.
const KIND: Record<Exclude<Phase, "switched">, FieldKind> = {
  subscribe: "quiet",
  confirming: "hold",
  preparing: "hold",
  choose: "quiet",
  waiting: "quiet",
  other: "quiet",
  joined: "done",
  ended: "stop",
  paused: "stop",
  suspended: "stop",
};

// The board repeats the signed-in email under the actions on a desktop only here.
const SIGNED_IN_ON_DESKTOP: Phase[] = ["subscribe", "choose", "waiting", "other", "joined"];

const PLUGIN_APPS: PluginApp[] = ["claude", "openai"];

/**
 * An app on a plugin platform carries Exomem's skills; any other app needs the
 * instructions pasted in, at the level the person picks.
 */
function hasPlugin(app: ListedApp): boolean {
  return PLUGIN_APPS.some((platform) => platform === app.platform);
}

/** An app on the list from GET /api/exomem/apps, as far as this page reads it. */
function listedApps(body: Record<string, unknown>): ListedApp[] {
  const apps = Array.isArray(body.apps) ? body.apps : [];
  return apps.flatMap((item: unknown) => {
    const app = item as Record<string, unknown>;
    return typeof app.id === "string" &&
      typeof app.displayName === "string" &&
      typeof app.lastAuthorizedAt === "string" &&
      (app.context === "coding" || app.context === "conversation")
      ? [
          {
            id: app.id,
            displayName: app.displayName,
            platform: typeof app.platform === "string" ? app.platform : null,
            context: app.context,
            lastAuthorizedAt: app.lastAuthorizedAt,
          },
        ]
      : [];
  });
}

/** Platforms with a live connection; a closed set, the client_platform CHECK values. */
function connectedPlatforms(apps: ListedApp[]): Set<string> {
  return new Set(apps.flatMap((app) => (app.platform ? [app.platform] : [])));
}

/**
 * The joined step for an app without the plugin: pick a level, read and copy its
 * instructions. The pick is saved for the app's context when the cell can take it.
 */
function JoinedLevels({ app }: { app: ListedApp }) {
  // The board starts an app without the plugin at Balanced, the coding agents' default.
  const { level, choose, save, savable } = useLevelSave(app.context, "balanced");
  return (
    <>
      <StepHeading
        title={joinedCopy.title(app.displayName)}
        lede={savable ? joinedCopy.ledeSaving : joinedCopy.ledeWithoutPlugin}
      />
      <LevelTune
        level={level}
        onLevel={choose}
        saveNote={
          save.kind === "not_saved"
            ? joinedCopy.notSaved
            : save.kind === "refused"
              ? save.text
              : save.kind === "saved"
                ? joinedCopy.saved(levelContextTitle(app.context).toLowerCase())
                : null
        }
      />
    </>
  );
}

export default function SetupClient({ facts }: { facts: SetupFacts }) {
  const [phase, setPhase] = useState<Phase>(facts.screen);
  const [waitingFor, setWaitingFor] = useState<PluginApp>("claude");
  const [joined, setJoined] = useState<ListedApp | null>(null);
  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keptUntil = useReaderDate(facts.keptUntil);

  // The server knows what comes next after a payment or a sign-out: ask it again.
  const onSettled = useCallback(() => window.location.reload(), []);
  const checkout = useCheckout(onSettled);
  const current: Phase = checkout.confirming ? "confirming" : phase;
  // A friend offer's price is not the previewed one, so it is not previewed.
  const price = usePaddlePricePreview(
    current === "subscribe" && !facts.friendInviter ? facts.priceId : null
  );

  // Preparing: ask for the cell's state until it is ready.
  useEffect(() => {
    if (current !== "preparing") return;
    let timer = 0;
    let active = true;
    const check = async () => {
      try {
        const body = await getPrivateJson("/api/exomem/status");
        const state = (body.status as { state?: unknown } | undefined)?.state;
        if (!active) return;
        if (state === "ready") {
          setPhase("choose");
          return;
        }
        if (state !== "preparing" && state !== "degraded") {
          // Anything else is a different step; the server page computes which.
          window.location.reload();
          return;
        }
      } catch {
        // Try again on the next beat; a lost session reloads into sign-in below.
      }
      if (active) timer = window.setTimeout(check, pollDelay(0));
    };
    void check();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [current]);

  // Choose: which assistants already have Exomem.
  useEffect(() => {
    if (current !== "choose" && current !== "joined") return;
    let active = true;
    getPrivateJson("/api/exomem/apps")
      .then((body) => {
        if (active) setConnected(connectedPlatforms(listedApps(body)));
      })
      .catch(() => {
        // Unknown stays unmarked: no row claims a connection it cannot show.
      });
    return () => {
      active = false;
    };
  }, [current]);

  // Waiting: poll the app list until an app connects after the first poll.
  useEffect(() => {
    if (current !== "waiting" && current !== "other") return;
    let timer = 0;
    let active = true;
    let baseline: string | null = null;
    const started = Date.now();
    const poll = async () => {
      try {
        const body = await getPrivateJson("/api/exomem/apps");
        if (!active) return;
        if (baseline === null) {
          baseline = typeof body.serverTime === "string" ? body.serverTime : null;
        } else {
          const apps = listedApps(body);
          const app = joinedSince(baseline, apps);
          if (app) {
            setConnected(connectedPlatforms(apps));
            setJoined(app);
            setPhase("joined");
            return;
          }
        }
      } catch {
        // Keep waiting; the next poll tries again.
      }
      if (active) timer = window.setTimeout(poll, pollDelay(Date.now() - started));
    };
    void poll();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [current]);

  async function resume() {
    setBusy(true);
    if (!(await openBillingPortal())) {
      setBusy(false);
      setFailure(failureCopy.generic);
    }
  }

  async function switchAccount() {
    if (!(await signOut())) {
      setFailure(failureCopy.generic);
      return;
    }
    // The page is now the start page: a reload shows it again.
    window.history.replaceState(null, "", "/exomem/sign-in");
    setPhase("switched");
  }

  if (current === "switched") {
    return (
      <StartFlow
        context={{ kind: "web" }}
        reviewerEnabled={facts.reviewerEnabled}
        frame={{}}
        notice={{ text: startCopy.switched(facts.email), attention: false }}
      />
    );
  }

  const goHome = () => window.location.assign("/exomem/home");
  const exportMemory = { label: breakCopy.export, onClick: goHome };
  const failureNotice = failure ? <StepNotice alert>{failure}</StepNotice> : null;
  const app = breakCopy.webApp;

  let body;
  switch (current) {
    case "subscribe":
      body = (
        <>
          <StepHeading
            title={subscribeCopy.title}
            lede={
              facts.friendInviter
                ? subscribeCopy.friendLede(facts.friendInviter, null)
                : subscribeLine(price)
            }
          />
          {checkout.failed ? <StepNotice alert>{failureCopy.generic}</StepNotice> : null}
          <StepActions
            primary={{
              label: subscribeCopy.primary,
              working: checkout.opening,
              onClick: () => void checkout.subscribe(),
            }}
            // The board leaves "Not now" without a target; Home keeps the unpaid account.
            secondary={{ label: subscribeCopy.notNow, onClick: goHome }}
          />
        </>
      );
      break;
    case "confirming":
      body = (
        <>
          <StepHeading
            title={subscribeCopy.confirming.title}
            lede={subscribeCopy.confirming.lede(null)}
          />
          <WorkingBar label={subscribeCopy.confirming.title} />
        </>
      );
      break;
    case "preparing":
      body = (
        <>
          <StepHeading title={inviteCopy.accepting.title} lede={inviteCopy.accepting.lede} />
          <WorkingBar label={inviteCopy.accepting.title} />
        </>
      );
      break;
    case "choose": {
      const choices: Choice[] = PLUGIN_APPS.map((platform) => {
        const name = CLIENT_PLATFORM_NAMES[platform];
        const isConnected = connected.has(platform);
        return {
          key: platform,
          name,
          also: chooseCopy.rows[platform].also,
          glyph: chooseCopy.rows[platform].glyph,
          cta: isConnected ? chooseCopy.connected : chooseCopy.open(name),
          current: isConnected,
          onPick: () => {
            setWaitingFor(platform);
            setPhase("waiting");
          },
        };
      });
      choices.push({
        key: "other",
        ...chooseCopy.other,
        current: false,
        onPick: () => setPhase("other"),
      });
      body = (
        <>
          <StepHeading title={chooseCopy.title} lede={chooseCopy.lede} />
          <ChoiceList choices={choices} />
        </>
      );
      break;
    }
    case "waiting": {
      const name = CLIENT_PLATFORM_NAMES[waitingFor];
      const settings = facts.settings[waitingFor];
      body = (
        <>
          <StepHeading
            title={waitingCopy.title(name)}
            lede={`${waitingCopy.where[waitingFor]} ${waitingCopy.then(name)}`}
          />
          <StepActions
            primary={
              settings
                ? { label: chooseCopy.open(name), onClick: () => openElsewhere(settings) }
                : null
            }
            secondary={{ label: waitingCopy.pickAnother, onClick: () => setPhase("choose") }}
          />
        </>
      );
      break;
    }
    case "other":
      body = (
        <>
          <StepHeading title={otherAppCopy.title} lede={otherAppCopy.lede} />
          {facts.mcpAddress ? (
            <AddressField
              label={otherAppCopy.addressLabel}
              address={facts.mcpAddress}
              labelHidden
            />
          ) : (
            <StepNotice alert>{failureCopy.generic}</StepNotice>
          )}
          <StepActions
            secondary={{ label: waitingCopy.pickAnother, onClick: () => setPhase("choose") }}
          />
        </>
      );
      break;
    case "joined": {
      const app = joined!;
      const plugin = hasPlugin(app);
      const next: PluginApp = app.platform === "claude" ? "openai" : "claude";
      body = (
        <>
          {plugin ? (
            <StepHeading title={joinedCopy.title(app.displayName)} lede={joinedCopy.lede} />
          ) : (
            <JoinedLevels app={app} />
          )}
          <StepActions
            primary={{ label: joinedCopy.home, onClick: goHome }}
            secondary={{
              label: connected.has(next)
                ? joinedCopy.another
                : joinedCopy.addToo(CLIENT_PLATFORM_NAMES[next]),
              onClick: () => setPhase("choose"),
            }}
          />
        </>
      );
      break;
    }
    case "ended":
      body = (
        <>
          <StepHeading
            title={breakCopy.ended.title}
            lede={
              breakCopy.ended.lede(keptUntil, app) +
              (facts.friendInviter ? breakCopy.ended.friendBack(facts.friendInviter) : "")
            }
          />
          <StepActions secondary={exportMemory} />
        </>
      );
      break;
    case "paused":
      body = (
        <>
          <StepHeading title={breakCopy.paused.title} lede={breakCopy.paused.lede(app)} />
          <StepActions
            primary={{
              label: breakCopy.paused.resume,
              working: busy,
              onClick: () => void resume(),
            }}
            secondary={exportMemory}
          />
        </>
      );
      break;
    case "suspended":
      body = (
        <>
          <StepHeading title={breakCopy.suspended.title} lede={breakCopy.suspended.lede(app)} />
          <StepNotice>{breakCopy.suspended.notice(facts.supportReference)}</StepNotice>
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
    <JourneyPage kind={KIND[current]} headerEmail={facts.email} stepKey={current}>
      {body}
      {failureNotice}
      <SignedInLine
        email={facts.email}
        onSwitch={() => void switchAccount()}
        onDesktop={SIGNED_IN_ON_DESKTOP.includes(current)}
      />
      {current === "waiting" ? (
        <WaitNote>{waitingCopy.waitingFor(CLIENT_PLATFORM_NAMES[waitingFor])}</WaitNote>
      ) : null}
      {current === "other" ? <WaitNote>{waitingCopy.waitingFor(UNNAMED_APP)}</WaitNote> : null}
      {current === "joined" && joined && hasPlugin(joined) ? (
        <DoneLine>{joinedCopy.done(joined.displayName)}</DoneLine>
      ) : null}
    </JourneyPage>
  );
}
