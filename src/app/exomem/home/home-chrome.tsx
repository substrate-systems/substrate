import type { CSSProperties, ReactNode } from "react";
import { LiveLine } from "@/components/exomem/LiveLine";
import { Mark } from "@/components/exomem/Mark";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { Wordmark } from "@/components/exomem/Wordmark";
import phone from "@/components/exomem/phone.module.css";
import { HOME_WEB_DESKTOP, HOME_WEB_PHONE, type HomeWebLayout } from "./home-web";
import styles from "./home.module.css";

function WebSvg({ layout, live, id }: { layout: HomeWebLayout; live: boolean; id: string }) {
  const lit = new Map(live ? layout.lit : []);
  const links = [];
  for (let i = 0; i < layout.links.length; i += 4) {
    links.push(
      <line
        key={i}
        className={styles.link}
        x1={layout.links[i]}
        y1={layout.links[i + 1]}
        x2={layout.links[i + 2]}
        y2={layout.links[i + 3]}
      />
    );
  }
  const notes = [];
  for (let i = 0; i < layout.notes.length / 3; i += 1) {
    const [cx, cy, r] = layout.notes.slice(i * 3, i * 3 + 3);
    const delay = lit.get(i);
    notes.push(
      delay === undefined ? (
        <circle key={i} className={styles.webNote} cx={cx} cy={cy} r={r} />
      ) : (
        <circle
          key={i}
          className={styles.litNote}
          cx={cx}
          cy={cy}
          r={layout.litRadius}
          style={{ "--hd": `${delay}s` } as CSSProperties}
        />
      )
    );
  }
  return (
    <svg
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      className={live ? styles.webLive : undefined}
      aria-hidden="true"
    >
      {links}
      {notes}
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.35" className={styles.fadeStart} />
          <stop offset="1" className={styles.fadeEnd} />
        </linearGradient>
      </defs>
      <rect width={layout.width} height={layout.height} fill={`url(#${id})`} />
    </svg>
  );
}

/** The web behind the header: lit while the memory is on, faint ink otherwise. */
export function HomeWeb({ live }: { live: boolean }) {
  return (
    <>
      <div className={`${styles.web} ${styles.webDesktop}`}>
        <WebSvg layout={HOME_WEB_DESKTOP} live={live} id="home-web-fade-desktop" />
      </div>
      <div className={`${styles.web} ${styles.webPhone}`}>
        <WebSvg layout={HOME_WEB_PHONE} live={live} id="home-web-fade-phone" />
      </div>
    </>
  );
}

export function HomeHeader({
  email,
  onSignOut,
  signingOut,
}: {
  email: string | null;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  return (
    <header className={styles.header}>
      <span className={styles.headerStart}>
        <span className={styles.wordmark}>
          <Wordmark />
        </span>
        <nav aria-label="Exomem" className={styles.nav}>
          <span aria-current="page" className={styles.navCurrent}>
            Home
          </span>
        </nav>
      </span>
      <span className={styles.headerEnd}>
        <ThemeToggle />
        <span>
          {email && <span className={styles.email}>{email} · </span>}
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
  liveLine: { text: string; key: string } | null;
  /** Said in place of the live line when the cell could not report activity. */
  activityNote?: string | null;
}) {
  return (
    <div className={styles.status}>
      <div className={styles.tile}>
        <Mark size={34} breathing={live} lit={live} label="Exomem" />
      </div>
      <div className={styles.statusText}>
        <h1 className={styles.headline}>{headline}</h1>
        {statusLine && <span className={styles.statusLine}>{statusLine}</span>}
        {liveLine && (
          // Not a live region: the time ticks every second, which a screen reader would repeat.
          <span className={styles.liveLine}>
            <LiveLine variant="home" eventKey={liveLine.key}>
              {liveLine.text}
            </LiveLine>
          </span>
        )}
        {!liveLine && activityNote && <span className={styles.statusLine}>{activityNote}</span>}
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <div className={styles.panel}>{children}</div>
    </section>
  );
}
