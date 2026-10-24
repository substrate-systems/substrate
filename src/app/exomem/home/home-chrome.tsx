"use client";

import { useMemo, useRef, useEffect, type ReactNode } from "react";
import { AliveGraph, fireAlive, type AliveEvent } from "@/components/exomem/AliveGraph";
import { LiveLine } from "@/components/exomem/LiveLine";
import { Mark } from "@/components/exomem/Mark";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { Wordmark } from "@/components/exomem/Wordmark";
import phone from "@/components/exomem/phone.module.css";
import { HOME_WEB_DESKTOP, HOME_WEB_PHONE, type HomeWebLayout } from "./home-web";
import styles from "./home.module.css";
import { CLIENT_FAMILY_GLYPHS } from "@/lib/exomem-hosted/client-platforms";
import type { ActivityClientFamily } from "@/lib/exomem-hosted/cloud-home-mcp";

function WebSvg({
  layout,
  live,
  id,
  activity,
}: {
  layout: HomeWebLayout;
  live: boolean;
  id: string;
  activity?: AliveEvent & { key: string };
}) {
  const graph = useMemo(() => {
    const nodes: [number, number, number][] = [];
    for (let i = 0; i < layout.notes.length; i += 3)
      nodes.push([layout.notes[i], layout.notes[i + 1], layout.notes[i + 2]]);
    const index = new Map(nodes.map(([x, y], i) => [`${x},${y}`, i]));
    const edges: [number, number][] = [];
    for (let i = 0; i < layout.links.length; i += 4) {
      const from = index.get(`${layout.links[i]},${layout.links[i + 1]}`);
      const to = index.get(`${layout.links[i + 2]},${layout.links[i + 3]}`);
      if (from !== undefined && to !== undefined) edges.push([from, to]);
    }
    return { nodes, edges };
  }, [layout]);
  const lastEvent = useRef<string | null>(null);
  useEffect(() => {
    if (live && activity && activity.key !== lastEvent.current) {
      // Home supplies only newly observed events, after its initial history read.
      fireAlive(id, activity);
      lastEvent.current = activity.key;
    }
  }, [activity, id, live]);
  return (
    <AliveGraph
      {...graph}
      id={id}
      state={live ? "live" : "cut"}
      walk
      clearHeader
      viewBox={`0 0 ${layout.width} ${layout.height}`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.35" className={styles.fadeStart} />
          <stop offset="1" className={styles.fadeEnd} />
        </linearGradient>
      </defs>
      <rect width={layout.width} height={layout.height} fill={`url(#${id})`} />
    </AliveGraph>
  );
}

/** The web behind the header: lit while the memory is on, faint ink otherwise. */
export function HomeWeb({
  live,
  activity,
}: {
  live: boolean;
  activity?: AliveEvent & { key: string };
}) {
  return (
    <>
      <div className={`${styles.web} ${styles.webDesktop}`}>
        <WebSvg
          layout={HOME_WEB_DESKTOP}
          live={live}
          id="home-web-fade-desktop"
          activity={activity}
        />
      </div>
      <div className={`${styles.web} ${styles.webPhone}`}>
        <WebSvg layout={HOME_WEB_PHONE} live={live} id="home-web-fade-phone" activity={activity} />
      </div>
    </>
  );
}

export function HomeHeader({
  email,
  onSignOut,
  signingOut,
  live = true,
  activityKey,
}: {
  email: string | null;
  onSignOut: () => void;
  signingOut: boolean;
  live?: boolean;
  activityKey?: string;
}) {
  return (
    <header className={`${styles.header} ${styles.homeHeader}`}>
      <span className={styles.headerStart}>
        <a
          className={styles.wordmark}
          href="/exomem/home"
          aria-label="Exomem home"
          data-graph-clear
        >
          <Wordmark state={live ? "rest" : "off"} activityKey={activityKey} />
        </a>
      </span>
      <span className={styles.headerEnd}>
        <ThemeToggle />
        <span className={styles.account} data-graph-clear>
          {email && (
            <span className={styles.email}>
              <span className={styles.emailAddress} title={email}>
                {email}
              </span>
              <span aria-hidden="true">·</span>
            </span>
          )}
          <button
            type="button"
            className={`${styles.inlineButton} ${phone.hitArea}`}
            onClick={onSignOut}
            aria-busy={signingOut || undefined}
          >
            Sign out
          </button>
        </span>
      </span>
    </header>
  );
}

export function StatusBlock({
  live,
  headline,
  statusLine,
  liveLine,
  activityNote = null,
}: {
  live: boolean;
  headline: string;
  statusLine: string | null;
  liveLine: { text: string; key: string; client?: ActivityClientFamily | null } | null;
  /** Said in place of the live line when the cell could not report activity. */
  activityNote?: string | null;
}) {
  return (
    <div className={styles.status}>
      <div className={styles.tile}>
        <Mark size={34} status={live ? "on" : "off"} label="Exomem" />
      </div>
      <div className={styles.statusText}>
        <h1 className={styles.headline}>{headline}</h1>
        {statusLine && <span className={styles.statusLine}>{statusLine}</span>}
        {liveLine && (
          // Not a live region: the time ticks every second, which a screen reader would repeat.
          <span className={styles.liveLine}>
            <LiveLine
              variant="home"
              eventKey={liveLine.key}
              active={live && liveLine.client !== undefined}
              glyph={
                liveLine.client
                  ? CLIENT_FAMILY_GLYPHS[liveLine.client]
                  : liveLine.client === null
                    ? "+"
                    : undefined
              }
            >
              {liveLine.text}
            </LiveLine>
          </span>
        )}
        {!liveLine && activityNote && <span className={styles.statusLine}>{activityNote}</span>}
      </div>
    </div>
  );
}

/**
 * A titled section; without children it draws no panel, not an empty one. An
 * `id` makes the section a link target, as the Cloud transfer tools do for "Your data".
 */
export function Section({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <section id={id} className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children !== undefined && <div className={styles.panel}>{children}</div>}
    </section>
  );
}
