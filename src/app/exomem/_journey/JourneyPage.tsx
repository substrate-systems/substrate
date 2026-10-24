"use client";

import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { FlowField, type FieldKind } from "@/components/exomem/FlowField";
import { PairedTiles } from "@/components/exomem/PairedTiles";
import { Wordmark } from "@/components/exomem/Wordmark";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { CLIENT_PLATFORM_GLYPHS } from "@/lib/exomem-hosted/client-platforms";
import { FadeIn } from "@/components/exomem/Transitions";
import phone from "@/components/exomem/phone.module.css";
import { wordmarkCopy } from "./copy";
import styles from "./journey.module.css";

/** Exomem's public landing, where a signed-out wordmark goes. */
const LANDING = "/exomem";
/** Where a signed-in wordmark goes. */
const HOME = "/exomem/home";

/** The app tile: its glyph is a mark, not a logo, and its name is the tile's title. */
export type AppTile = { name: string; glyph: ReactNode; glyphSize: number };

/** The tile for an app, from its platform and where its codes go (the board's APPS). */
export function appTile(app: { displayName: string; platform: string | null; loopback: boolean }) {
  // A loopback app runs in a terminal on this computer: Claude Code, Codex or any CLI.
  if (app.loopback) return { name: app.displayName, glyph: ">_", glyphSize: 17 };
  // `platform` is the closed client_platform set (claude | openai).
  if (app.platform === "claude" || app.platform === "openai") {
    return {
      name: app.displayName,
      glyph: CLIENT_PLATFORM_GLYPHS[app.platform],
      glyphSize: 20,
    };
  }
  return { name: app.displayName, glyph: "MCP", glyphSize: 12 };
}

/** What the page's tiles and field show, from the step (phaseOf() and kindOf() in the board). */
function tilesState(kind: FieldKind): "idle" | "connecting" | "connected" | "stopped" {
  if (kind === "go") return "connecting";
  if (kind === "done") return "connected";
  if (kind === "stop") return "stopped";
  return "idle";
}

type JourneyPageProps = {
  kind: FieldKind;
  /** The app that opened the page; none when the person started on our site. */
  app?: AppTile;
  /** Signed in: the email in the header (desktop). */
  headerEmail?: string | null;
  /**
   * Signed in, the wordmark goes to Home. A step that shows no account (the board's
   * handback and kept steps, signedIn: false) is still signed in.
   */
  signedIn?: boolean;
  /** A page an app opened: where the request came from. */
  footer?: string | null;
  /**
   * The board lights the tiles from the step's phase (phaseOf()), which is connected only
   * once an app has connected. A settled change that connects no app, such as a friend
   * price added, settles the field but keeps the tiles idle: the mark stays grey.
   */
  tilesIdle?: boolean;
  /** Changes when the flow shows a new step. */
  stepKey: string;
  /** A person started this transition; initial loading leaves focus alone. */
  focusHeading?: boolean;
  /** Changes when the same status must be heard again, such as a repeated failed sign-in. */
  announceKey?: number;
  onPairMotionComplete?: (state: "connecting" | "connected") => void;
  /** None while the page waits for its first answer. */
  children?: ReactNode;
};

export function JourneyPage({
  kind,
  app,
  headerEmail,
  signedIn = !!headerEmail,
  footer,
  tilesIdle = false,
  stepKey,
  focusHeading = false,
  announceKey = 0,
  onPairMotionComplete,
  children,
}: JourneyPageProps) {
  const content = useRef<HTMLDivElement>(null);
  const announceAgain = useRef<() => void>(() => {});
  const previousStep = useRef<string | null>(null);
  const status = useRef<HTMLDivElement>(null);
  // Connecting ends once the tiles' cycle and the whole field have both played, however
  // fast the answer came; the seal that follows is the tiles' own. A layout effect resets
  // the step before the parts' own effects run, so it never erases a part's report.
  const played = useRef({ tiles: false, field: false });
  useLayoutEffect(() => {
    played.current = { tiles: false, field: false };
  }, [kind]);
  const settle = useCallback(
    (part: "tiles" | "field", state: "connecting" | "connected") => {
      played.current[part] = true;
      const { tiles, field } = played.current;
      if (tiles && (field || state === "connected")) onPairMotionComplete?.(state);
    },
    [onPairMotionComplete]
  );
  const tilesPlayed = useCallback(
    (state: "connecting" | "connected") => settle("tiles", state),
    [settle]
  );
  const fieldLit = useCallback(() => settle("field", "connecting"), [settle]);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    let written: string | null = null;
    let marked = false;
    const announce = (again = false) => {
      const current = element.cloneNode(true) as HTMLElement;
      current
        .querySelectorAll('[aria-hidden="true"], [inert]')
        .forEach((hidden) => hidden.remove());
      const message = [
        current.querySelector("h1"),
        ...current.querySelectorAll("[data-step-status]"),
      ]
        .map((node) => node?.textContent?.trim())
        .filter(Boolean)
        .join(". ");
      if (!status.current || (message === written && !again)) return;
      // A screen reader repeats a status only when the text changes, so a repeat
      // alternates a trailing no-break space, which is not read aloud.
      marked = again && message === written ? !marked : false;
      written = message;
      status.current.textContent = marked ? `${message}\u00a0` : message;
    };
    announceAgain.current = () => announce(true);
    announce();
    const observer = new MutationObserver(() => announce());
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "inert"],
    });
    return () => observer.disconnect();
  }, []);
  const announcedKey = useRef(announceKey);
  useLayoutEffect(() => {
    if (announcedKey.current === announceKey) return;
    announcedKey.current = announceKey;
    announceAgain.current();
  }, [announceKey]);
  useLayoutEffect(() => {
    if (focusHeading && previousStep.current !== stepKey) {
      content.current
        ?.querySelector<HTMLElement>("[data-step-focus], h1")
        ?.focus({ preventScroll: true });
    }
    previousStep.current = stepKey;
  }, [stepKey, focusHeading]);
  return (
    <main className={`${styles.page} brand-exomem`} data-alive-surface>
      <FlowField
        kind={kind}
        footer={!!footer}
        onLit={onPairMotionComplete ? fieldLit : undefined}
      />
      {/* Signed in, the wordmark goes to Home; signed out, to the landing. */}
      <a
        className={`${styles.wordmark} ${phone.hitArea}`}
        href={signedIn ? HOME : LANDING}
        aria-label={signedIn ? wordmarkCopy.home : wordmarkCopy.landing}
        data-graph-clear
      >
        <Wordmark state={kind === "stop" ? "off" : "rest"} />
      </a>
      {/* The theme control stays at the gutter; the email sits before it (Journey board). */}
      <div className={styles.headerControls} data-graph-header>
        {headerEmail ? (
          <div className={styles.headerEmail} data-graph-clear>
            {headerEmail}
          </div>
        ) : null}
        <ThemeToggle align="end" />
      </div>
      <div className={styles.center}>
        <div className={styles.column}>
          <div className={styles.tiles}>
            <PairedTiles
              state={tilesIdle ? "idle" : tilesState(kind)}
              app={app}
              onMotionComplete={onPairMotionComplete ? tilesPlayed : undefined}
            />
          </div>
          <div className={styles.content} ref={content}>
            <FadeIn key={stepKey}>{children}</FadeIn>
          </div>
        </div>
      </div>
      {footer ? (
        <div className={styles.footer}>
          <span className={styles.footerText}>{footer}</span>
        </div>
      ) : null}
      <div ref={status} className={styles.status} role="status" aria-live="polite" aria-atomic />
    </main>
  );
}
