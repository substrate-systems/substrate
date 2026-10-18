"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import {
  currentExomemThemeChoice,
  EXOMEM_THEME_CHANGE_EVENT,
  EXOMEM_THEME_CHOICES,
  exomemThemeSaveState,
  setExomemThemeChoice,
  type ExomemThemeChoice,
} from "@/lib/exomem/theme";
import styles from "./ThemeToggle.module.css";

// Every toggle on the page follows the theme on <html>, whoever changed it.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-theme-choice"],
  });
  window.addEventListener(EXOMEM_THEME_CHANGE_EVENT, onChange);
  return () => {
    observer.disconnect();
    window.removeEventListener(EXOMEM_THEME_CHANGE_EVENT, onChange);
  };
}

function snapshot() {
  return JSON.stringify({
    choice: currentExomemThemeChoice(document.documentElement),
    error: exomemThemeSaveState().error,
  });
}
const serverSnapshot = () => '{"choice":"auto","error":null}';

function themeLabel(choice: ExomemThemeChoice) {
  return choice === "auto" ? "Auto" : choice === "light" ? "Light" : "Dark";
}

/** The R52 glyphs are fixed drawings, shared by the menu and the closed control. */
function ThemeGlyph({ choice }: { choice: ExomemThemeChoice }) {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" aria-hidden="true">
      {choice === "auto" ? (
        <>
          <circle cx="7.5" cy="7.5" r="6" fill="none" stroke="currentColor" strokeWidth="1.425" />
          <path d="M7.5 1.50 A6.00 6.00 0 0 0 7.5 13.50 Z" fill="currentColor" />
        </>
      ) : choice === "dark" ? (
        <path
          d="M9.00 1.50 A6.00 6.00 0 1 0 13.50 9.00 A4.68 4.68 0 0 1 9.00 1.50 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.425"
          strokeLinejoin="round"
        />
      ) : (
        <>
          <circle cx="7.5" cy="7.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.425" />
          <path
            d="M12.60 7.50h1.80 M11.11 11.11l1.27 1.27 M7.50 12.60v1.80 M3.89 11.11l-1.27 1.27 M2.40 7.50H.60 M3.89 3.89 2.62 2.62 M7.50 2.40V.60 M11.11 3.89l1.27-1.27"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.425"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

/** One account-aware theme menu; existing imports share the same control. */
export function ThemeToggle({ align = "start" }: { align?: "start" | "end" }) {
  const { choice, error } = JSON.parse(
    useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  ) as { choice: ExomemThemeChoice; error: string | null };
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  useLayoutEffect(() => {
    if (open) rows.current[EXOMEM_THEME_CHOICES.indexOf(choice)]?.focus();
  }, [open, choice]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function close() {
    setOpen(false);
    button.current?.focus();
  }
  function navigate(event: KeyboardEvent) {
    const index = rows.current.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = (index + 1) % EXOMEM_THEME_CHOICES.length;
    else if (event.key === "ArrowUp")
      next = (index + EXOMEM_THEME_CHOICES.length - 1) % EXOMEM_THEME_CHOICES.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = EXOMEM_THEME_CHOICES.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    } else if (event.key === "Tab") {
      close();
      return;
    } else return;
    event.preventDefault();
    rows.current[next]?.focus();
  }
  return (
    <span ref={host} className={`${styles.control} ${align === "end" ? styles.end : ""}`}>
      <button
        ref={button}
        type="button"
        className={styles.button}
        data-graph-clear
        data-graph-control
        aria-label={`Theme: ${themeLabel(choice)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        <span className={styles.choiceAuto}>
          <ThemeGlyph choice="auto" />
        </span>
        <span className={styles.choiceLight}>
          <ThemeGlyph choice="light" />
        </span>
        <span className={styles.choiceDark}>
          <ThemeGlyph choice="dark" />
        </span>
      </button>
      {open && (
        <span
          id={id}
          role="menu"
          aria-label="Theme"
          className={styles.menu}
          onKeyDown={navigate}
          onBlur={(event) => {
            if (!host.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
          }}
        >
          {EXOMEM_THEME_CHOICES.map((option, index) => (
            <button
              key={option}
              ref={(element) => {
                rows.current[index] = element;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={choice === option}
              tabIndex={-1}
              className={styles.row}
              onClick={() => {
                void setExomemThemeChoice(document.documentElement, option);
                close();
              }}
            >
              <ThemeGlyph choice={option} />
              <span className={styles.label}>{themeLabel(option)}</span>
              {choice === option && (
                <span className={styles.check} aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
