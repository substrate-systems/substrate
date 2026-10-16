"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FieldKind } from "@/components/exomem/FlowField";
import {
  getPrivateJson,
  HostedBrowserError,
  postPrivateJson,
  postPublicJson,
  takeFragmentToken,
} from "@/lib/exomem-hosted/hosted-browser";
import type { InvitationDecision, InvitationInspection } from "@/lib/exomem-hosted/invites";
import { signOut } from "../_journey/account-actions";
import { failureCopy, inviteCopy, TRY_AGAIN } from "../_journey/copy";
import { JourneyPage } from "../_journey/JourneyPage";
import {
  DoneLine,
  InviteNote,
  PriceCard,
  SignedInLine,
  StepActions,
  StepHeading,
  StepNotice,
} from "../_journey/parts";
import { friendPriceOffered, friendPriceUnchecked, inviterOf, pricePanel } from "./invite-view";

type Choice = "use_friend_price" | "keep_plan";

type Mode =
  | { kind: "checking" }
  | { kind: "invite"; inspection: InvitationInspection; failure: string | null }
  | { kind: "accepting"; inspection: InvitationInspection; failure: string | null }
  | {
      kind: "existing";
      inspection: InvitationInspection;
      failure: string | null;
      /** The friend price turned out not to apply when the owner asked for it. */
      refusedFriendPrice: boolean;
    }
  | { kind: "deciding"; inspection: InvitationInspection; choice: Choice }
  | { kind: "decided"; decision: InvitationDecision["status"]; by: string | null }
  | { kind: "unusable" }
  /** Inspecting failed on our side: the same link may work in a moment. */
  | { kind: "failed" };

// kindOf() in the board: nothing is connected yet, so the field is quiet; a friend price
// added is a settled change.
const KIND: Record<Mode["kind"], FieldKind> = {
  checking: "quiet",
  invite: "quiet",
  accepting: "hold",
  existing: "quiet",
  deciding: "quiet",
  decided: "quiet",
  unusable: "quiet",
  failed: "quiet",
};

// A refused token (expired, used, revoked, malformed) is final: one identical answer
// that names no one. A retryable refusal means Exomem cannot open it right now.
function refused(error: unknown): boolean {
  return error instanceof HostedBrowserError && !error.retryable;
}

/** The answer of POST /api/exomem/access/inspect, as far as this page reads it. */
function inspectionOf(body: Record<string, unknown>): InvitationInspection | null {
  const price = body.price as { value?: unknown; reason?: unknown } | undefined;
  const kindOk = body.kind === "standard" || body.kind === "friend" || body.kind === "covered";
  // Only the owner signed in here learns the prices of an existing owner's invitation.
  const withheld = body.status === "existing" && body.signedIn === false;
  const priceOk =
    withheld ||
    (price !== undefined &&
      ((price.value !== null && typeof price.value === "object") ||
        (price.value === null && typeof price.reason === "string")));
  const statusOk =
    body.status === "invite" || (body.status === "existing" && typeof body.signedIn === "boolean");
  return kindOk && priceOk && statusOk ? (body as unknown as InvitationInspection) : null;
}

function decisionOf(body: Record<string, unknown>): InvitationDecision["status"] | null {
  return body.status === "applied" ||
    body.status === "applied_on_resubscribe" ||
    body.status === "kept"
    ? body.status
    : null;
}

/** The signed-in owner's email, for "Signed in as …"; null when it cannot be read. */
async function ownerEmail(): Promise<string | null> {
  try {
    const body = await getPrivateJson("/api/exomem/account");
    const email = (body.account as { email?: unknown } | undefined)?.email;
    return typeof email === "string" ? email : null;
  } catch {
    return null;
  }
}

/**
 * An invitation link. The token is in the fragment; the page takes it out of the
 * address bar first. A new person accepts, which creates the Exomem and signs this
 * browser in: a paid invitation continues at setup, a covered one at Home, and one
 * opened from an app's consent page continues that connection (the redeem route
 * decides). An address that already has an Exomem answers it instead: take the friend
 * price on the plan it has, or keep the plan.
 */
export default function InviteClient() {
  const token = useRef<string | null>(null);
  const started = useRef(false);
  const [mode, setMode] = useState<Mode>({ kind: "checking" });
  const [email, setEmail] = useState<string | null>(null);
  const [focusHeading, setFocusHeading] = useState(false);
  const [inspecting, setInspecting] = useState(false);

  const inspect = useCallback(async (userAction = false) => {
    if (userAction) setFocusHeading(true);
    if (!token.current) return;
    setInspecting(true);
    try {
      const inspection = inspectionOf(
        await postPublicJson("/api/exomem/access/inspect", { token: token.current })
      );
      if (!inspection) {
        setMode({ kind: "failed" });
        return;
      }
      if (inspection.status === "invite") {
        setMode({ kind: "invite", inspection, failure: null });
        return;
      }
      setMode({ kind: "existing", inspection, failure: null, refusedFriendPrice: false });
      setEmail(inspection.signedIn ? await ownerEmail() : null);
    } catch (error) {
      setMode({ kind: refused(error) ? "unusable" : "failed" });
    } finally {
      setInspecting(false);
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    token.current = takeFragmentToken();
    if (!token.current) setMode({ kind: "unusable" });
    else void inspect();
  }, [inspect]);

  async function accept(inspection: InvitationInspection) {
    if (!token.current) return;
    setFocusHeading(true);
    setMode({
      kind: "accepting",
      inspection,
      failure: mode.kind === "invite" ? mode.failure : null,
    });
    try {
      const result = await postPublicJson("/api/exomem/access/redeem", {
        token: token.current,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        emailScheme: document.documentElement.getAttribute("data-theme"),
      });
      token.current = null;
      window.location.replace(
        typeof result.destination === "string" ? result.destination : "/exomem/home"
      );
    } catch (error) {
      if (refused(error)) setMode({ kind: "unusable" });
      else setMode({ kind: "invite", inspection, failure: failureCopy.invitationNotReady });
    }
  }

  async function decide(inspection: InvitationInspection, choice: Choice) {
    if (!token.current) return;
    setFocusHeading(true);
    setMode({ kind: "deciding", inspection, choice });
    const back = (failure: string, refusedFriendPrice = false) =>
      setMode({ kind: "existing", inspection, failure, refusedFriendPrice });
    try {
      const decision = decisionOf(
        await postPrivateJson("/api/exomem/invites/decision", { token: token.current, choice })
      );
      if (!decision) {
        back(inviteCopy.existing.notFinished);
        return;
      }
      token.current = null;
      setFocusHeading(true);
      setMode({ kind: "decided", decision, by: inviterOf(inspection) });
    } catch (error) {
      if (!(error instanceof HostedBrowserError)) {
        back(inviteCopy.existing.notFinished);
      } else if (error.status === 401) {
        // The session ended: the page asks the owner to sign in.
        void inspect();
      } else if (error.code === "INVITATION_UNUSABLE") {
        setMode({ kind: "unusable" });
      } else if (error.code === "FRIEND_PRICE_NOT_OFFERED") {
        back(inviteCopy.existing.notOffered, true);
      } else if (error.retryable) {
        // 503: Paddle or the friend discount did not answer. The invitation stays
        // usable, but an update may have reached Paddle, so nothing claims it did not.
        back(inviteCopy.existing.notFinished);
      } else {
        back(failureCopy.generic);
      }
    }
  }

  async function switchAccount() {
    if (await signOut()) {
      setEmail(null);
      void inspect(true);
    }
  }

  const goHome = () => window.location.assign("/exomem/home");
  const signedInLine = email ? (
    <SignedInLine email={email} onSwitch={() => void switchAccount()} onDesktop />
  ) : null;

  let body;
  switch (mode.kind) {
    case "checking":
      body = null;
      break;
    case "unusable":
      body = (
        <>
          <StepHeading title={inviteCopy.unusable.title} lede={inviteCopy.unusable.lede} />
          <StepActions
            primary={{
              label: inviteCopy.unusable.primary,
              onClick: () => window.location.assign("/exomem/sign-in"),
            }}
          />
        </>
      );
      break;
    case "failed":
      body = (
        <>
          <StepNotice alert>{failureCopy.generic}</StepNotice>
          <StepActions
            primary={{ label: TRY_AGAIN, working: inspecting, onClick: () => void inspect(true) }}
          />
        </>
      );
      break;
    case "accepting":
    case "invite": {
      const { inspection } = mode;
      const by = inviterOf(inspection);
      const panel = pricePanel(inspection);
      body = (
        <>
          <StepHeading
            title={by ? inviteCopy.friendTitle(by) : inviteCopy.standardTitle}
            lede={inviteCopy.lede}
          />
          <StepNotice alert visible={!!mode.failure}>
            {mode.failure ?? failureCopy.invitationNotReady}
          </StepNotice>
          {by && inspection.note ? <InviteNote note={inspection.note} by={by} /> : null}
          {panel ? <PriceCard {...panel} /> : null}
          <StepActions
            primary={{
              label: mode.kind === "accepting" ? inviteCopy.accepting.title : inviteCopy.accept,
              working: mode.kind === "accepting",
              onClick: () => void accept(inspection),
            }}
          />
        </>
      );
      break;
    }
    case "existing":
    case "deciding": {
      const { inspection } = mode;
      const by = inviterOf(inspection);
      const signedIn = inspection.status === "existing" && inspection.signedIn;
      if (!signedIn) {
        body = (
          <>
            <StepHeading title={inviteCopy.existing.title} lede={inviteCopy.existing.signIn(by)} />
            <StepActions
              primary={{
                label: inviteCopy.existing.signInPrimary,
                onClick: () => window.location.assign("/exomem/sign-in"),
              }}
            />
          </>
        );
        break;
      }
      const deciding = mode.kind === "deciding" ? mode.choice : null;
      const refusedNow = mode.kind === "existing" && mode.refusedFriendPrice;
      const offered = friendPriceOffered(inspection) && !refusedNow;
      // Paddle did not answer: the page offers neither the friend price nor a refusal,
      // and lets the owner ask again.
      const unchecked = friendPriceUnchecked(inspection) && !refusedNow;
      const panel = offered ? pricePanel(inspection) : null;
      const failure = mode.kind === "existing" ? mode.failure : null;
      const keep = {
        label: inviteCopy.existing.keep,
        disabled: deciding !== null && deciding !== "keep_plan",
        working: deciding === "keep_plan",
        onClick: () => void decide(inspection, "keep_plan"),
      };
      body = (
        <>
          <StepHeading
            title={inviteCopy.existing.title}
            lede={
              offered && by
                ? inviteCopy.existing.lede(by)
                : unchecked && by
                  ? inviteCopy.existing.unchecked(by)
                  : inspection.kind === "friend" && by
                    ? inviteCopy.existing.otherPrice(by)
                    : inviteCopy.existing.noOffer(by)
            }
          />
          <StepNotice alert visible={!!failure}>
            {failure ?? inviteCopy.existing.notFinished}
          </StepNotice>
          {panel ? <PriceCard {...panel} /> : null}
          <StepActions
            primary={
              offered && by
                ? {
                    label: inviteCopy.existing.useFriendPrice(by),
                    disabled: deciding !== null && deciding !== "use_friend_price",
                    working: deciding === "use_friend_price",
                    onClick: () => void decide(inspection, "use_friend_price"),
                  }
                : unchecked
                  ? {
                      label: TRY_AGAIN,
                      disabled: deciding !== null,
                      working: inspecting,
                      onClick: () => void inspect(true),
                    }
                  : keep
            }
            secondary={(offered && by) || unchecked ? keep : null}
          />
          {signedInLine}
        </>
      );
      break;
    }
    case "decided": {
      const by = mode.by ?? "";
      const copy =
        mode.decision === "applied"
          ? inviteCopy.applied
          : mode.decision === "applied_on_resubscribe"
            ? inviteCopy.appliedOnResubscribe
            : null;
      body = copy ? (
        <>
          <StepHeading title={copy.title} lede={copy.lede(by)} />
          <StepActions primary={{ label: inviteCopy.home, onClick: goHome }} />
          {signedInLine}
          <DoneLine>{copy.done}</DoneLine>
        </>
      ) : (
        <>
          <StepHeading title={inviteCopy.kept.title} lede={inviteCopy.kept.lede} />
          <StepActions primary={{ label: inviteCopy.home, onClick: goHome }} />
          {signedInLine}
        </>
      );
      break;
    }
  }

  const kind: FieldKind =
    mode.kind === "decided" && mode.decision !== "kept" ? "done" : KIND[mode.kind];
  return (
    <JourneyPage
      kind={kind}
      headerEmail={email}
      tilesIdle
      stepKey={
        mode.kind === "accepting"
          ? "invite"
          : mode.kind === "deciding"
            ? "existing"
            : mode.kind === "existing" &&
                mode.inspection.status === "existing" &&
                !mode.inspection.signedIn
              ? "existing-signedout"
              : mode.kind
      }
      focusHeading={focusHeading}
    >
      {body}
    </JourneyPage>
  );
}
