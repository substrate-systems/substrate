"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { FlowField, type FieldKind } from "@/components/exomem/FlowField";
import { PairedTiles } from "@/components/exomem/PairedTiles";
import { Wordmark } from "@/components/exomem/Wordmark";
import { CLIENT_PLATFORM_GLYPHS } from "@/lib/exomem-hosted/client-platforms";
import { FadeIn } from "@/components/exomem/Transitions";
import phone from "@/components/exomem/phone.module.css";
import styles from "./journey.module.css";

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
  /** The signed-in navigation destination can differ from the visible email. */
  homeHref?: string;
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
  onPairMotionComplete?: (state: "connecting" | "connected") => void;
  /** None while the page waits for its first answer. */
  children?: ReactNode;
};

export function JourneyPage({
  kind,
  app,
  headerEmail,
  homeHref = "/exomem/home",
  footer,
  tilesIdle = false,
  stepKey,
  focusHeading = false,
  onPairMotionComplete,
  children,
}: JourneyPageProps) {
  const content = useRef<HTMLDivElement>(null);
  const previousStep = useRef<string | null>(null);
  const status = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const announce = () => {
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
      if (status.current && status.current.textContent !== message)
        status.current.textContent = message;
    };
    announce();
    const observer = new MutationObserver(announce);
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-hidden", "inert"],
    });
    return () => observer.disconnect();
  }, []);
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
      <FlowField kind={kind} footer={!!footer} />
      {headerEmail ? (
        <a
          className={`${styles.wordmark} ${phone.hitArea}`}
          href={homeHref}
          aria-label="Exomem home"
        >
          <Wordmark state={kind === "stop" ? "off" : "rest"} />
        </a>
      ) : (
        <div className={styles.wordmark}>
          <Wordmark state={kind === "stop" ? "off" : "rest"} />
        </div>
      )}
      {headerEmail ? <div className={styles.headerEmail}>{headerEmail}</div> : null}
      <div className={styles.center}>
        <div className={styles.column}>
          <div className={styles.tiles}>
            <PairedTiles
              state={tilesIdle ? "idle" : tilesState(kind)}
              app={app}
              onMotionComplete={onPairMotionComplete}
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
