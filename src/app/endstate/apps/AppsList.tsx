"use client";

import { useMemo, useState } from "react";
import type { SupportedApp } from "@/lib/endstate-apps";

export default function AppsList({ apps }: { apps: SupportedApp[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (app) =>
        app.name.toLowerCase().includes(q) || app.slug.toLowerCase().includes(q),
    );
  }, [apps, query]);

  return (
    <div>
      <label htmlFor="app-search" className="sr-only">
        Search supported apps
      </label>
      <input
        id="app-search"
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for an app…"
        className="w-full rounded-md border border-border-subtle bg-transparent px-4 py-3 text-body font-light text-fg-primary placeholder:text-fg-tertiary focus:border-fg-tertiary focus:outline-none"
      />

      <p className="mt-4 text-body-sm text-fg-tertiary">
        {filtered.length === apps.length
          ? `${apps.length} apps`
          : `${filtered.length} of ${apps.length} apps`}
      </p>

      {filtered.length === 0 ? (
        <p className="mt-10 text-body font-light text-fg-secondary">
          No match for “{query}”. It may not have a settings module yet — the list
          is open source and growing.
        </p>
      ) : (
        <ul className="mt-8 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 md:grid-cols-4">
          {filtered.map((app) => (
            <li
              key={app.slug}
              className="text-body-sm font-light text-fg-secondary"
            >
              {app.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
