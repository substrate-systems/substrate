import { browserCookie, csrfCookie, postPrivateJson } from "@/lib/exomem-hosted/hosted-browser";
import { exomemThemeCookieName, themeBindingFromCsrfToken } from "./theme-binding";

export type ExomemTheme = "dark" | "light";
// The three modes are fixed by the account preference protocol.
export const EXOMEM_THEME_CHOICES = ["auto", "light", "dark"] as const;
export type ExomemThemeChoice = (typeof EXOMEM_THEME_CHOICES)[number];
export const EXOMEM_THEME_CHANGE_EVENT = "exomem-theme-change";

export type ExomemThemeSnapshot = {
  scope: string;
  binding: string;
  choice: ExomemThemeChoice | null;
  effective: ExomemTheme | null;
  expiresAt: string | null;
};

export function exomemThemeChoice(value: unknown): ExomemThemeChoice | null {
  return value === "auto" || value === "light" || value === "dark" ? value : null;
}

export function effectiveExomemTheme(
  choice: ExomemThemeChoice,
  deviceIsLight: boolean
): ExomemTheme {
  return choice === "auto" ? (deviceIsLight ? "light" : "dark") : choice;
}

export function readExomemThemeSnapshot(raw: unknown): ExomemThemeSnapshot | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (
      typeof value.scope !== "string" ||
      value.scope.length > 128 ||
      typeof value.binding !== "string" ||
      value.binding.length > 128 ||
      (value.choice !== null &&
        value.choice !== "auto" &&
        value.choice !== "light" &&
        value.choice !== "dark") ||
      (value.effective !== null && value.effective !== "light" && value.effective !== "dark")
    )
      return null;
    if (
      value.expiresAt !== null &&
      (typeof value.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(value.expiresAt)) ||
        Date.parse(value.expiresAt) <= Date.now())
    )
      return null;
    return value as ExomemThemeSnapshot;
  } catch {
    return null;
  }
}

const KEYS = {
  choice: "exomem-theme-choice",
  legacy: "exomem-theme",
  account: "exomem-theme-account",
};

/** Shared by the synchronous bundle and the hydrated account controls. */
function applyStoredTheme(root: HTMLElement): ExomemTheme {
  const binding = browserThemeBinding();
  let snapshot: ExomemThemeSnapshot | null = null;
  try {
    snapshot = readExomemThemeSnapshot(browserCookie(exomemThemeCookieName(binding)));
  } catch {
    /* Ignore malformed presentation cookies. */
  }
  if (binding && snapshot?.binding !== binding) {
    snapshot = { scope: "", binding, choice: "auto", effective: null, expiresAt: null };
  } else if (!binding) snapshot = null;
  let browserChoice: ExomemThemeChoice = "auto";
  try {
    let stored = window.localStorage.getItem(KEYS.choice);
    if (stored === null) {
      const legacy = window.localStorage.getItem(KEYS.legacy);
      stored = legacy === "light" || legacy === "dark" ? legacy : "auto";
      window.localStorage.setItem(KEYS.choice, stored);
      window.localStorage.removeItem(KEYS.legacy);
    }
    if (stored === "light" || stored === "dark") browserChoice = stored;
  } catch {
    // Storage can be blocked; the device and current account still work.
  }
  const choice = snapshot
    ? snapshot.scope
      ? (snapshot.choice ?? browserChoice)
      : "auto"
    : browserChoice;
  try {
    if (snapshot?.scope)
      window.localStorage.setItem(KEYS.account, JSON.stringify({ scope: snapshot.scope, choice }));
    else window.localStorage.removeItem(KEYS.account);
  } catch {
    // The account cookie remains the canonical browser snapshot.
  }
  let deviceIsLight = false;
  if (choice === "auto") {
    try {
      deviceIsLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    } catch {
      /* Unknown device renders dark. */
    }
  }
  const effective = effectiveExomemTheme(choice, deviceIsLight);
  root.setAttribute("data-exomem", "");
  root.setAttribute("data-theme-choice", choice);
  root.setAttribute("data-theme-scope", snapshot?.scope ?? "");
  root.setAttribute(
    "data-theme-initialized",
    snapshot?.scope && snapshot.choice === null ? "false" : "true"
  );
  if (root.getAttribute("data-theme") !== effective) root.setAttribute("data-theme", effective);
  return effective;
}

export function isExomemPath(pathname: string): boolean {
  return pathname === "/exomem" || pathname.indexOf("/exomem/") === 0;
}

type ThemeSaveState = { status: "idle" | "saving" | "saved" | "failed"; error: string | null };
let saveState: ThemeSaveState = { status: "idle", error: null };
let pending: { scope: string; binding: string; choice: ExomemThemeChoice } | null = null;
let saveSequence = Promise.resolve();
let version = 0;

export function exomemThemeSaveState(): ThemeSaveState {
  return { ...saveState };
}

function announce(): void {
  window.dispatchEvent(new Event(EXOMEM_THEME_CHANGE_EVENT));
}

export function currentExomemTheme(root: HTMLElement): ExomemTheme {
  return root.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function currentExomemThemeChoice(root: HTMLElement): ExomemThemeChoice {
  return exomemThemeChoice(root.getAttribute("data-theme-choice")) ?? "auto";
}

function showChoice(root: HTMLElement, choice: ExomemThemeChoice): void {
  let deviceIsLight = false;
  if (choice === "auto") {
    try {
      deviceIsLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    } catch {
      /* Unknown device renders dark. */
    }
  }
  const effective = effectiveExomemTheme(choice, deviceIsLight);
  root.setAttribute("data-theme-choice", choice);
  if (root.getAttribute("data-theme") !== effective) root.setAttribute("data-theme", effective);
}

export function applyExomemTheme(root: HTMLElement): ExomemTheme {
  applyStoredTheme(root);
  const scope = root.getAttribute("data-theme-scope") ?? "";
  if (pending?.scope === scope && pending.binding === browserThemeBinding())
    showChoice(root, pending.choice);
  else if (pending) {
    pending = null;
    saveState = { status: "idle", error: null };
  }
  return currentExomemTheme(root);
}

function browserThemeBinding(): string {
  try {
    return themeBindingFromCsrfToken(csrfCookie());
  } catch {
    return "";
  }
}

/** The picked theme applies immediately; account persistence has a separate visible state. */
export async function setExomemThemeChoice(
  root: HTMLElement,
  choice: ExomemThemeChoice,
  options: { initialize?: true; effectiveOnly?: true } = {}
): Promise<boolean> {
  const scope = root.getAttribute("data-theme-scope") ?? "";
  const binding = browserThemeBinding();
  showChoice(root, choice);
  pending = { scope, binding, choice };
  try {
    window.localStorage.setItem(
      scope ? KEYS.account : KEYS.choice,
      scope ? JSON.stringify({ scope, choice }) : choice
    );
  } catch {
    /* A blocked cache never stops the current tab. */
  }
  if (!scope) {
    announce();
    return true;
  }
  const effective = currentExomemTheme(root);
  const currentVersion = ++version;
  saveState = { status: "saving", error: null };
  announce();
  let saved = false;
  saveSequence = saveSequence.then(async () => {
    applyExomemTheme(root);
    if (root.getAttribute("data-theme-scope") !== scope || browserThemeBinding() !== binding)
      return;
    try {
      const response = await postPrivateJson(
        "/api/exomem/account/preferences",
        {
          themeChoice: choice,
          emailScheme: effective,
          ...options,
        },
        "PUT"
      );
      if (response.success !== true || !exomemThemeChoice(response.themeChoice))
        throw new Error("The theme was not saved.");
      const refreshed = readExomemThemeSnapshot(JSON.stringify(response.themeSnapshot));
      const currentBinding = browserThemeBinding();
      if (!refreshed || refreshed.scope !== scope || refreshed.binding !== currentBinding) return;
      document.cookie = `${exomemThemeCookieName(refreshed.binding)}=${encodeURIComponent(JSON.stringify(refreshed))}; Path=/; SameSite=Lax${refreshed.expiresAt ? `; Expires=${new Date(refreshed.expiresAt).toUTCString()}` : ""}${location.protocol === "https:" ? "; Secure" : ""}`;
      saved = true;
      if (currentVersion === version) {
        pending = null;
        saveState = { status: "saved", error: null };
        applyExomemTheme(root);
      }
    } catch (error) {
      if (currentVersion === version && root.getAttribute("data-theme-scope") === scope)
        saveState = {
          status: "failed",
          error: error instanceof Error ? error.message : "The theme was not saved.",
        };
    }
    announce();
  });
  await saveSequence;
  return saved && currentVersion === version;
}

/** Compatibility for the current control until the three-choice control is ported. */
export function setExomemTheme(root: HTMLElement, theme: ExomemTheme): void {
  void setExomemThemeChoice(root, theme);
}

export function followDeviceTheme(root: HTMLElement): () => void {
  const reapply = () => {
    applyExomemTheme(root);
    if (currentExomemThemeChoice(root) === "auto" && root.getAttribute("data-theme-scope")) {
      void setExomemThemeChoice(root, "auto", { effectiveOnly: true });
    }
    announce();
  };
  if (
    root.getAttribute("data-theme-scope") &&
    root.getAttribute("data-theme-initialized") === "false"
  ) {
    void setExomemThemeChoice(root, currentExomemThemeChoice(root), { initialize: true });
  } else if (root.getAttribute("data-theme-scope") && currentExomemThemeChoice(root) === "auto") {
    void setExomemThemeChoice(root, "auto", { effectiveOnly: true });
  }
  window.addEventListener("storage", reapply);
  try {
    const device = window.matchMedia("(prefers-color-scheme: light)");
    device.addEventListener("change", reapply);
    return () => {
      device.removeEventListener("change", reapply);
      window.removeEventListener("storage", reapply);
    };
  } catch {
    return () => window.removeEventListener("storage", reapply);
  }
}

export function clearExomemTheme(root: HTMLElement): void {
  for (const attribute of [
    "data-exomem",
    "data-theme",
    "data-theme-choice",
    "data-theme-scope",
    "data-theme-initialized",
  ])
    root.removeAttribute(attribute);
}
