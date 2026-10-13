"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Cloudflare Turnstile for "Start with your email": a Managed widget that stays
// invisible (appearance "interaction-only") unless Cloudflare wants a person to
// click, and then shows its one-click check where the page put the container. The
// server checks the token's action, so the widget is rendered with action "start".
//
// The site key is configuration. Local runs and tests set Cloudflare's documented
// test site key; production sets the real one. Without a key there is no widget and
// the request goes without a token, and the server decides (see turnstile.ts).

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const ACTION = "start";

type RenderOptions = {
  sitekey: string;
  action: string;
  appearance: "interaction-only";
  execution: "execute";
  theme: "light" | "dark";
  size: "flexible";
  callback: (token: string) => void;
  "error-callback": () => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
  "before-interactive-callback": () => void;
  "after-interactive-callback": () => void;
};

type TurnstileApi = {
  render: (container: HTMLElement, options: RenderOptions) => string;
  execute: (widgetId: string) => void;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error("no api"));
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error("turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export class ChallengeError extends Error {}

/**
 * Renders the widget into whichever element `mount` is given as its ref (the step
 * that shows it may remount) and hands out one token per request. `token()`
 * resolves with "" when no site key is configured.
 */
export function useTurnstile(siteKey: string | null) {
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  // Cloudflare asks for a click: the page makes room for the check.
  const [asking, setAsking] = useState(false);
  // Only the latest element gets the widget: React may attach, detach and attach again.
  const attached = useRef(0);
  const ready = useRef<Promise<void> | null>(null);
  const cached = useRef<string | null>(null);
  const started = useRef(false);
  const running = useRef(false);
  const waiting = useRef<{ resolve: (token: string) => void; reject: (e: Error) => void } | null>(
    null
  );

  useEffect(() => {
    if (!siteKey) console.error("[exomem] NEXT_PUBLIC_EXOMEM_TURNSTILE_SITE_KEY is not set");
  }, [siteKey]);

  const execute = useCallback(() => {
    const current = widget.current;
    if (!current) return;
    running.current = true;
    try {
      current.api.execute(current.id);
    } catch {
      running.current = false;
      const pending = waiting.current;
      waiting.current = null;
      pending?.reject(new ChallengeError("challenge unavailable"));
    }
  }, []);

  const mount = useCallback(
    (element: HTMLDivElement | null) => {
      attached.current += 1;
      const attachment = attached.current;
      cached.current = null;
      running.current = false;
      if (widget.current) {
        widget.current.api.remove(widget.current.id);
        widget.current = null;
      }
      if (!element || !siteKey) return;
      const settle = (outcome: string | Error) => {
        const pending = waiting.current;
        waiting.current = null;
        if (!pending) return;
        if (typeof outcome === "string") pending.resolve(outcome);
        else pending.reject(outcome);
      };
      ready.current = loadTurnstile().then((api) => {
        if (attachment !== attached.current || !element.isConnected) return;
        const theme =
          document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
        const id = api.render(element, {
          sitekey: siteKey,
          action: ACTION,
          appearance: "interaction-only",
          execution: "execute",
          theme,
          size: "flexible",
          callback: (token) => {
            cached.current = token;
            running.current = false;
            settle(token);
          },
          "error-callback": () => {
            running.current = false;
            settle(new ChallengeError("challenge error"));
          },
          "expired-callback": () => {
            cached.current = null;
            running.current = false;
            api.reset(id);
            if (started.current) execute();
          },
          "timeout-callback": () => {
            running.current = false;
            settle(new ChallengeError("challenge timed out"));
          },
          "before-interactive-callback": () => setAsking(true),
          "after-interactive-callback": () => setAsking(false),
        });
        widget.current = { api, id };
      });
      // A failed background load is surfaced by token() when the person submits.
      void ready.current.catch(() => {});
    },
    [siteKey, execute]
  );

  /** Start on the first edit, before the person needs the token. */
  const start = useCallback(async () => {
    if (!siteKey) return;
    started.current = true;
    try {
      await ready.current;
    } catch {
      return;
    }
    const current = widget.current;
    if (!current || cached.current || running.current) return;
    execute();
  }, [siteKey, execute]);

  /** Takes the prepared token, or waits for the check already running. */
  const token = useCallback(async (): Promise<string> => {
    if (!siteKey) return "";
    try {
      await ready.current;
    } catch {
      throw new ChallengeError("challenge unavailable");
    }
    const current = widget.current;
    if (!current) throw new ChallengeError("challenge unavailable");
    if (cached.current) return cached.current;
    return new Promise<string>((resolve, reject) => {
      waiting.current = { resolve, reject };
      void start();
    });
  }, [siteKey, start]);

  /** Tokens work once: reset after every request, so the next one gets its own. */
  const reset = useCallback(() => {
    waiting.current = null;
    cached.current = null;
    running.current = false;
    if (widget.current) widget.current.api.reset(widget.current.id);
  }, []);

  return { mount, start, token, reset, asking };
}
