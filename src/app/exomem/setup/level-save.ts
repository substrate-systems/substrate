"use client";

// The joined step saves the level the person picks for an app without the plugin, with the
// calls Home makes (GET and PUT /api/exomem/cloud/home/levels). A level belongs to a context,
// every chat app or every coding agent, so the page says which. While the Home channel is
// off, or the cell cannot take the level, the choice stays on screen and the page says it
// is not saved; it never shows a save that did not happen. When a write's answer is lost,
// the page reads the levels again and reports what the cell holds.

import { useCallback, useEffect, useRef, useState } from "react";
import type { InvolvementLevelKey } from "@/components/exomem/involvement-levels";
import {
  NOT_RELEASED,
  readLevels,
  writeLevel,
  type HomeLevels,
  type LevelContext,
} from "../home/home-api";
import { levelRefusalText, levelsView } from "../home/home-view";

type LevelsRead = HomeLevels | typeof NOT_RELEASED;
type LiveLevels = Extract<HomeLevels, { state: "live" }>;

export type LevelSave =
  /** Nothing picked yet: the page claims nothing. */
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  /** The channel is off, the cell cannot take it, or the cell still holds the old level. */
  | { kind: "not_saved" }
  /** The cell refused: read-only, an operator setting, or a change made elsewhere. */
  | { kind: "refused"; text: string };

function liveLevels(read: LevelsRead | null): LiveLevels | null {
  return read && read !== NOT_RELEASED && read.state === "live" ? read : null;
}

/** Live levels the person may change; the reason in words when they may not. */
function lockedText(levels: LiveLevels): string | null {
  const view = levelsView(levels);
  if (view.state === "live" && view.lockedText) return view.lockedText;
  return levels.writable ? null : levelRefusalText("CLOUD_CELL_READ_ONLY");
}

export function useLevelSave(context: LevelContext, initial: InvolvementLevelKey) {
  const [level, setLevel] = useState<InvolvementLevelKey>(initial);
  const [read, setRead] = useState<LevelsRead | null>(null);
  const [save, setSave] = useState<LevelSave>({ kind: "idle" });
  const latest = useRef<LevelsRead | null>(null);
  const wanted = useRef<InvolvementLevelKey | null>(null);
  const running = useRef(false);

  const remember = useCallback((value: LevelsRead | null) => {
    latest.current = value;
    setRead(value);
  }, []);

  // The switch starts on the stored level when the cell can say what it is.
  useEffect(() => {
    let active = true;
    readLevels().then(
      (value) => {
        if (!active) return;
        remember(value);
        const levels = liveLevels(value);
        if (levels && wanted.current === null && !running.current) {
          setLevel(levels.levels[context].level);
        }
      },
      () => {
        // Signed out or unreadable: the page shows its starting level and claims no save.
      }
    );
    return () => {
      active = false;
    };
  }, [context, remember]);

  // One save at a time; the newest pick wins.
  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setSave({ kind: "saving" });
    try {
      while (wanted.current !== null) {
        const next = wanted.current;
        let levels = liveLevels(latest.current);
        if (!levels) {
          // The channel or the cell may be back since the page read it.
          remember(await readLevels());
          levels = liveLevels(latest.current);
        }
        if (!levels) {
          wanted.current = null;
          setSave({ kind: "not_saved" });
          break;
        }
        const locked = lockedText(levels);
        if (locked) {
          wanted.current = null;
          setSave({ kind: "refused", text: locked });
          break;
        }
        const before = levels.levels[context].level;
        const result = await writeLevel(context, next, levels.revision).catch(() => null);
        if (wanted.current === next) wanted.current = null;
        if (result?.kind === "written") {
          remember(result.view);
          if (wanted.current === null) setSave({ kind: "saved" });
          continue;
        }
        if (result?.kind === "refused") {
          wanted.current = null;
          remember(result.view);
          const current = liveLevels(result.view);
          if (current) setLevel(current.levels[context].level);
          setSave({ kind: "refused", text: levelRefusalText(result.code) });
          break;
        }
        // The answer was lost or said the cell is out of reach, and the write may have
        // landed all the same: the page reports what the cell holds now.
        const after = await readLevels().catch(() => null);
        remember(after ?? result?.view ?? null);
        const held = liveLevels(after)?.levels[context].level ?? null;
        if (held === next) {
          if (wanted.current === null) setSave({ kind: "saved" });
          continue;
        }
        wanted.current = null;
        if (held === null || held === before) {
          setSave({ kind: "not_saved" });
        } else {
          setLevel(held);
          setSave({ kind: "refused", text: levelRefusalText("PREFERENCE_CONFLICT") });
        }
        break;
      }
    } catch {
      wanted.current = null;
      setSave({ kind: "not_saved" });
    } finally {
      running.current = false;
    }
  }, [context, remember]);

  const choose = useCallback(
    (next: InvolvementLevelKey) => {
      setLevel(next);
      wanted.current = next;
      void drain();
    },
    [drain]
  );

  const levels = liveLevels(read);
  return {
    level,
    choose,
    save,
    /** The cell can take a level now, so the page may promise to save the choice. */
    savable: levels !== null && lockedText(levels) === null,
  };
}
