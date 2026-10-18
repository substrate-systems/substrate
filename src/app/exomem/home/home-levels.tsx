"use client";

import { SegmentedSwitch } from "@/components/exomem/SegmentedSwitch";
import { INVOLVEMENT_LEVELS, involvementLevel } from "@/components/exomem/involvement-levels";
import type { LevelContext, LevelKey } from "./home-api";
import type { LevelsView } from "./home-view";
import { Section } from "./home-chrome";
import styles from "./home.module.css";

const OPTIONS = INVOLVEMENT_LEVELS.map((level) => ({ value: level.key, label: level.label }));

export function InvolvementLevels({
  view,
  pending,
  message,
  onChange,
}: {
  view: LevelsView;
  /** The context whose write is in flight. */
  pending: LevelContext | null;
  /** What the last refused write means, until the next change. */
  message: string | null;
  onChange: (context: LevelContext, level: LevelKey, revision: string) => void;
}) {
  if (view.state === "hidden") return null;
  return (
    <Section title="How much Exomem joins in">
      {view.state === "loading" && (
        <div className={styles.panelNote} aria-busy="true">
          Reading your levels…
        </div>
      )}
      {view.state === "unavailable" && <div className={styles.panelNote}>{view.text}</div>}
      {view.state === "live" &&
        view.rows.map((row) => {
          const locked = view.lockedText !== null;
          return (
            <div className={styles.levelRow} key={row.context}>
              <div className={styles.rowText}>
                <span className={styles.levelTitle}>
                  <span className={styles.rowTitle}>{row.title}</span>
                  {row.isDefault && <span className={styles.levelMeta}>default</span>}
                </span>
                <span className={styles.levelDescription}>
                  {involvementLevel(row.level).description}
                </span>
              </div>
              <div className={`${styles.levelSwitch} ${locked ? styles.locked : ""}`}>
                {/* Pending writes keep focus on the clicked segment; locked levels stay disabled. */}
                <fieldset
                  className={styles.fieldset}
                  disabled={locked}
                  aria-disabled={pending !== null || undefined}
                  aria-busy={pending === row.context || undefined}
                >
                  <SegmentedSwitch
                    size="row"
                    label={`How much Exomem joins in for ${row.title.toLowerCase()}`}
                    options={OPTIONS}
                    value={row.level}
                    onChange={(level) => {
                      if (pending === null && level !== row.level)
                        onChange(row.context, level, view.revision);
                    }}
                  />
                </fieldset>
              </div>
            </div>
          );
        })}
      {view.state === "live" && (
        <div className={styles.panelNote} aria-live="polite">
          {message ?? view.lockedText}
          {view.lockedText === null && (
            <>
              {message && " "}
              Your assistant can change these too. Ask it to use Exomem more, or less.
            </>
          )}
        </div>
      )}
    </Section>
  );
}
