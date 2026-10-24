"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ButtonLink } from "@/components/exomem/Button";
import { EXOMEM_SIGN_IN_EVENT_KEY, getPrivateJson } from "@/lib/exomem-hosted/hosted-browser";

const Session = createContext<boolean | null>(null);

export function LandingSession({
  children,
  className,
}: {
  children: ReactNode;
  className: string;
}) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    let timer = 0;
    let controller: AbortController | null = null;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      window.clearTimeout(timer);
      // Coalesce browser return events; a newer read supersedes the previous session snapshot.
      controller?.abort();
      timer = window.setTimeout(() => {
        const current = new AbortController();
        controller = current;
        void getPrivateJson(
          "/api/exomem/access/session",
          AbortSignal.any([current.signal, AbortSignal.timeout(10_000)])
        ).then(
          (result) => {
            if (!current.signal.aborted)
              setAuthenticated(
                typeof result.authenticated === "boolean" ? result.authenticated : null
              );
          },
          () => {
            if (!current.signal.aborted) setAuthenticated(null);
          }
        );
      }, 0);
    };
    const signInChanged = (event: StorageEvent) => {
      if (event.key === EXOMEM_SIGN_IN_EVENT_KEY) refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("storage", signInChanged);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => {
      window.clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("storage", signInChanged);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return (
    <Session.Provider value={authenticated}>
      <div className={className}>{children}</div>
    </Session.Provider>
  );
}

export function LandingAccountLink(
  props: { kind: "navigation"; className: string } | { kind: "action" }
) {
  const authenticated = useContext(Session);
  const href = authenticated === true ? "/exomem/home" : "/exomem/sign-in";
  if (props.kind === "navigation") {
    const label =
      authenticated === true ? "Home" : authenticated === false ? "Sign in" : "Open Exomem";
    return (
      <Link href={href} className={props.className}>
        {label}
      </Link>
    );
  }
  const label =
    authenticated === true
      ? "Go to Home"
      : authenticated === false
        ? "Start with your email"
        : "Open Exomem";
  return (
    <ButtonLink href={href} variant="primary" size="landing">
      {label} →
    </ButtonLink>
  );
}
