"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { Button, ButtonLink } from "@/components/exomem/Button";
import { FilterChip } from "@/components/exomem/FilterChip";
import { Mark } from "@/components/exomem/Mark";
import { ThemeToggle } from "@/components/exomem/ThemeToggle";
import { TagChip } from "@/components/exomem/TagChip";
import { PhoneSheet } from "@/components/exomem/PhoneSheet";
import { FadeIn, Swap } from "@/components/exomem/Transitions";
import { useAliveGraph } from "@/components/exomem/AliveGraph";
import { trimEdge } from "@/components/exomem/alive-engine";
import { HostedBrowserError, postPrivateJson } from "@/lib/exomem-hosted/hosted-browser";
import type { ViewerMapView, ViewerNote, ViewerSearch } from "@/lib/exomem-hosted/cloud-viewer";
import { layoutMap, primaryRelations, relationIdentity, relationLine } from "./map-layout";
import { describeNote, NoteMarkdown } from "./note-markdown";
import styles from "./viewer.module.css";

type MapNote = ViewerMapView["nodes"][number];
type Reach = "loading" | "live" | "lost" | "signed_out";

async function readViewer<T>(operation: "map" | "search" | "read", body: Record<string, unknown>) {
  const result = await postPrivateJson(`/api/exomem/cloud/viewer/${operation}`, body);
  if (result.state !== "live" || typeof result.tenantId !== "string")
    throw new Error("The view is unavailable");
  return { tenantId: result.tenantId, value: result.value as T };
}

function accountChanged(error: unknown) {
  return error instanceof HostedBrowserError && (error.status === 401 || error.status === 403);
}

function asOf(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function MapSurface({
  map,
  selected,
  hidden,
  held,
  paused,
  onPick,
  children,
}: {
  map: ViewerMapView;
  selected: string | null;
  hidden: Set<string>;
  held: boolean;
  paused: boolean;
  onPick: (note: MapNote) => void;
  children: ReactNode;
}) {
  const id = useId();
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const placement = useMemo(() => layoutMap(map), [map]);
  const nodes = useMemo(
    () =>
      placement.map((node) => ({
        ...node,
        x: (node.x * size.width) / 1000,
        y: (node.y * size.height) / 700,
      })),
    [placement, size]
  );
  const byKey = useMemo(() => new Map(nodes.map((node) => [node.node_key, node])), [nodes]);
  const meanings = new Map(map.vocabulary.map((row) => [relationIdentity(row), row]));
  const engineData = JSON.stringify({
    n: nodes.map(({ x, y, r }) => [x, y, r]),
    e: map.edges.flatMap((edge) => {
      const a = nodes.findIndex((node) => node.node_key === edge.src_key);
      const b = nodes.findIndex((node) => node.node_key === edge.dst_key);
      return a >= 0 && b >= 0 && !hidden.has(relationIdentity(edge.relation_identity))
        ? [[a, b]]
        : [];
    }),
  });
  const motionStopped = held || paused;
  const svg = useAliveGraph(id, motionStopped ? "cut" : "live", engineData);
  const gestures = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const [view, setView] = useState<ZoomTransform>(zoomIdentity);
  useEffect(() => {
    const target = stage.current;
    if (!target) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(target);
    // D3 handles drag, wheel and touch pinch together, including click suppression after a drag.
    const behavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent([0.5, 4])
      .extent(() => [
        [0, 0],
        [target.clientWidth, target.clientHeight],
      ])
      .filter(
        (event) =>
          !event.target.closest("button") &&
          (!event.ctrlKey || event.type === "wheel") &&
          !event.button
      )
      .on("zoom", (event) => setView(event.transform));
    gestures.current = behavior;
    select(target).call(behavior);
    return () => {
      observer.disconnect();
      select(target).on(".zoom", null);
      gestures.current = null;
    };
  }, []);
  return (
    <div className={styles.stage} ref={stage}>
      <div
        className={styles.layer}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg
          ref={svg}
          viewBox={`0 0 ${size.width} ${size.height}`}
          aria-hidden
          className={styles.graph}
          data-alive={motionStopped ? "off" : "loop"}
          data-graph={engineData}
          data-alive-key={id}
          data-walk="ink"
          data-hover={motionStopped ? undefined : "glow"}
        >
          {map.edges.map((edge) => {
            if (hidden.has(relationIdentity(edge.relation_identity))) return null;
            const from = byKey.get(edge.src_key),
              to = byKey.get(edge.dst_key);
            if (!from || !to) return null;
            const [a, b] = trimEdge(from, to);
            const active = selected === from.node_key || selected === to.node_key;
            const line = relationLine(
              meanings.get(relationIdentity(edge.relation_identity))?.presentation_role
            );
            return (
              <line
                key={edge.edge_key}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={line.amber && !held ? "var(--exo-amber)" : "var(--fg-primary)"}
                strokeWidth={active ? line.width : 1}
                strokeDasharray={line.dash}
                strokeOpacity={held ? 0.05 : active ? line.selected : line.overview}
                data-exo-t=""
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {nodes.map((node) => (
            <circle
              key={node.node_key}
              data-graph-node
              cx={node.x}
              cy={node.y}
              r={node.r}
              className={node.node_key === selected && !held ? styles.currentNode : styles.node}
            />
          ))}
        </svg>
        {nodes.map((node, index) => (
          <button
            key={node.node_key}
            type="button"
            className={styles.mapNote}
            style={{
              left: `${(node.x * 100) / size.width}%`,
              top: `${(node.y * 100) / size.height}%`,
            }}
            aria-label={node.title || node.path}
            aria-pressed={node.node_key === selected}
            data-label-side={node.x > size.width / 2 ? "left" : "right"}
            onClick={() => onPick(node)}
          >
            <span
              className={index < 4 || node.node_key === selected ? styles.label : styles.hoverLabel}
            >
              {node.title || node.path}
            </span>
          </button>
        ))}
      </div>
      <div className={styles.zoom}>
        <Button
          variant="ghost"
          onClick={() => {
            if (stage.current && gestures.current)
              select(stage.current).call(gestures.current.scaleBy, 1.25);
          }}
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            if (stage.current && gestures.current)
              select(stage.current).call(gestures.current.scaleBy, 1 / 1.25);
          }}
          aria-label="Zoom out"
        >
          −
        </Button>
        <Button
          variant="ghost"
          aria-label="Show everything"
          onClick={() => {
            if (stage.current && gestures.current)
              select(stage.current).call(gestures.current.transform, zoomIdentity);
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width="13"
            height="13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            aria-hidden
          >
            <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
          </svg>
        </Button>
      </div>
      {children}
    </div>
  );
}

export default function ViewerClient() {
  const [map, setMap] = useState<ViewerMapView | null>(null);
  const [tenant, setTenant] = useState<string | null>(null);
  const [reach, setReach] = useState<Reach>("loading");
  const [selected, setSelected] = useState<MapNote | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<ViewerSearch | null>(null);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "done" | "lost">("idle");
  const [preview, setPreview] = useState<{ note: ViewerNote | null; lost: boolean } | null>(null);
  const [reader, setReader] = useState<{
    ref: string;
    note: ViewerNote | null;
    lost: boolean;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [moreRelations, setMoreRelations] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const generation = useRef(0);
  const mapRequest = useRef(0);
  const noteRequest = useRef(0);
  const previewRequest = useRef(0);
  const searchRequest = useRef(0);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const searchField = useRef<HTMLInputElement>(null);
  const readerHeading = useRef<HTMLHeadingElement>(null);
  const binding = useRef<string | null>(null);
  const signedOut = useCallback(() => {
    generation.current += 1;
    noteRequest.current += 1;
    mapRequest.current += 1;
    previewRequest.current += 1;
    searchRequest.current += 1;
    binding.current = null;
    setTenant(null);
    setMap(null);
    setSelected(null);
    setReader(null);
    setPreview(null);
    setSearch(null);
    setQuery("");
    setReach("signed_out");
  }, []);
  const refreshMap = useCallback(async () => {
    const request = ++mapRequest.current;
    try {
      const result = await readViewer<ViewerMapView>(
        "map",
        binding.current ? { tenantId: binding.current } : {}
      );
      if (request !== mapRequest.current) return;
      if (binding.current && result.tenantId !== binding.current) {
        signedOut();
        return;
      }
      binding.current = result.tenantId;
      setRetryAttempt(0);
      setTenant(result.tenantId);
      setMap(result.value);
      setReach("live");
      setSelected((current) =>
        current
          ? (result.value.nodes.find((node) => node.node_key === current.node_key) ?? null)
          : null
      );
    } catch (error) {
      if (request !== mapRequest.current) return;
      if (accountChanged(error)) signedOut();
      else {
        setRetryAttempt((attempt) => attempt + 1);
        setReach("lost");
      }
    }
  }, [signedOut]);
  // This callback publishes only after an awaited server read, never synchronously in this effect.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshMap();
    return () => {
      mapRequest.current += 1;
    };
  }, [refreshMap]);
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") void refreshMap();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [refreshMap]);
  useEffect(() => {
    if (reach !== "lost") return;
    const timer = window.setTimeout(
      () => void refreshMap(),
      Math.min(60_000, 8000 * 2 ** Math.max(0, retryAttempt - 1))
    );
    return () => window.clearTimeout(timer);
  }, [reach, refreshMap, retryAttempt]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        searchField.current?.focus();
      }
      if (event.key === "Escape") {
        setQuery("");
        setSearch(null);
        setMoreRelations(false);
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const searchNotes = useCallback(
    async (phrase: string, continuation?: string) => {
      const owner = binding.current;
      if (!owner) return;
      const issued = generation.current;
      const request = ++searchRequest.current;
      setSearchState("loading");
      try {
        const result = await readViewer<ViewerSearch>("search", {
          tenantId: owner,
          query: phrase,
          ...(continuation ? { continuation } : {}),
        });
        if (request !== searchRequest.current || issued !== generation.current) return;
        if (result.tenantId !== owner) {
          signedOut();
          return;
        }
        setSearch((current) => {
          const seen = new Set<string>();
          // Each result opens a parent note; retain its first ranked match across pages.
          const hits = [
            ...(continuation ? (current?.hits ?? []) : []),
            ...result.value.hits,
          ].filter((hit) => {
            if (seen.has(hit.path)) return false;
            seen.add(hit.path);
            return true;
          });
          return {
            ...result.value,
            hits,
            partial: result.value.partial || Boolean(continuation && current?.partial),
          };
        });
        setSearchState("done");
      } catch (error) {
        if (request !== searchRequest.current || issued !== generation.current) return;
        if (accountChanged(error)) signedOut();
        else {
          if (!continuation) setSearch(null);
          setSearchState("lost");
        }
      }
    },
    [signedOut]
  );
  useEffect(() => {
    if (!query.trim() || !tenant) return;
    const timer = window.setTimeout(() => void searchNotes(query.trim()), 250);
    return () => {
      searchRequest.current += 1;
      window.clearTimeout(timer);
    };
  }, [query, tenant, searchNotes]);
  const loadPreview = useCallback(
    async (note: MapNote) => {
      const owner = binding.current;
      if (!owner) return;
      const request = ++previewRequest.current;
      const issued = generation.current;
      setPreview({ note: null, lost: false });
      try {
        const result = await readViewer<ViewerNote>("read", {
          tenantId: owner,
          ref: note.memory_ref ?? note.path,
        });
        if (request !== previewRequest.current || issued !== generation.current) return;
        if (result.tenantId !== owner) signedOut();
        else setPreview({ note: result.value, lost: false });
      } catch (error) {
        if (request !== previewRequest.current || issued !== generation.current) return;
        if (accountChanged(error)) signedOut();
        else setPreview({ note: null, lost: true });
      }
    },
    [signedOut]
  );
  const readNote = useCallback(
    async (ref: string) => {
      const owner = binding.current;
      if (!owner) return;
      const request = ++noteRequest.current;
      const issued = generation.current;
      searchRequest.current += 1;
      previewRequest.current += 1;
      setReader({ ref, note: null, lost: false });
      setQuery("");
      setSearch(null);
      setCopied(false);
      try {
        const result = await readViewer<ViewerNote>("read", { tenantId: owner, ref });
        if (request !== noteRequest.current || issued !== generation.current) return;
        if (result.tenantId !== owner) {
          signedOut();
          return;
        }
        setSelected(map?.nodes.find((note) => note.path === result.value.path) ?? null);
        setPreview({ note: result.value, lost: false });
        setReader({ ref, note: result.value, lost: false });
        requestAnimationFrame(() => readerHeading.current?.focus());
      } catch (error) {
        if (request !== noteRequest.current || issued !== generation.current) return;
        if (accountChanged(error)) signedOut();
        else setReader({ ref, note: null, lost: true });
      }
    },
    [map, signedOut]
  );
  const openNote = useCallback(
    (ref: string) => {
      void readNote(ref);
    },
    [readNote]
  );
  const related =
    selected && map
      ? map.edges.filter(
          (edge) => edge.src_key === selected.node_key || edge.dst_key === selected.node_key
        )
      : [];
  const description = useMemo(
    () => (reader?.note ? describeNote(reader.note.body) : null),
    [reader]
  );
  const previewSummary = useMemo(
    () =>
      preview?.note
        ? typeof preview.note.frontmatter.summary === "string"
          ? preview.note.frontmatter.summary
          : describeNote(preview.note.body).summary
        : null,
    [preview]
  );
  const title =
    reader?.note && typeof reader.note.frontmatter.title === "string"
      ? reader.note.frontmatter.title
      : (description?.heading ??
        map?.nodes.find((node) => node.path === reader?.note?.path)?.title ??
        reader?.note?.path ??
        selected?.title ??
        "Your knowledge");
  const emptyVault = map?.state === "complete" && map.counts.eligible_nodes === 0;
  const held = reach !== "live";
  const closeReader = () => {
    noteRequest.current += 1;
    setReader(null);
  };
  const pick = (note: MapNote) => {
    setSelected(note);
    closeReader();
    setQuery("");
    setSearch(null);
    void loadPreview(note);
  };
  const topRelations = map ? primaryRelations(map.vocabulary) : [];
  const chip = (meaning: ViewerMapView["vocabulary"][number]) => {
    const key = relationIdentity(meaning),
      line = relationLine(meaning.presentation_role);
    return (
      <FilterChip
        key={key}
        pressed={!hidden.has(key)}
        title={`${meaning.description} · ${meaning.instance}`}
        line={{
          stroke: line.amber ? "var(--exo-amber)" : "var(--fg-primary)",
          width: line.width,
          dash: line.dash,
          opacity: 0.7,
        }}
        onClick={() =>
          setHidden((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
      >
        {meaning.definition_key}
      </FilterChip>
    );
  };
  return (
    <main className={`brand-exomem ${styles.page}`} data-reach={reach}>
      <header className={styles.header}>
        <a href="/exomem/home" className={styles.wordmark} aria-label="Exomem home">
          <Mark size={26} state={reach === "lost" ? "off" : "rest"} />
        </a>
        <div className={styles.search}>
          <span aria-hidden>/</span>
          <input
            ref={searchField}
            type="search"
            aria-label="Search notes"
            placeholder="Search your notes…"
            disabled={!tenant}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearch(null);
              setSearchState("loading");
            }}
          />
          <span className={styles.shortcut} aria-hidden>
            ⌘K
          </span>
          {query.trim() && (
            <div className={styles.results}>
              <p>
                {searchState === "loading"
                  ? "Searching your notes…"
                  : searchState === "lost"
                    ? "Search is out of reach. Try again."
                    : `Results for “${query}”`}
              </p>
              {search?.partial && <p>Some search results are unavailable. Try again later.</p>}
              {searchState === "done" && search?.hits.length === 0 && !search.partial && (
                <p>No notes found. Try a different word or phrase.</p>
              )}
              {search?.hits.map((hit) => (
                <button
                  key={hit.ref ?? hit.path}
                  type="button"
                  onClick={() => openNote(hit.ref ?? hit.path)}
                >
                  {hit.title || hit.path}
                  <span>{hit.excerpt}</span>
                </button>
              ))}
              {(search?.continuation || searchState === "lost") && (
                <Button
                  variant="ghost"
                  disabled={searchState === "loading"}
                  onClick={() => void searchNotes(query.trim(), search?.continuation ?? undefined)}
                >
                  {searchState === "lost" ? "Try again" : "More results"}
                </Button>
              )}
            </div>
          )}
        </div>
        {map && map.vocabulary.length > 0 && !reader && (
          <nav className={styles.filters} aria-label="Relation types">
            {topRelations.map(chip)}
            {map.vocabulary.length > topRelations.length && (
              <Button
                variant="ghost"
                aria-expanded={moreRelations}
                onClick={() => setMoreRelations((current) => !current)}
              >
                +{map.vocabulary.length - topRelations.length}
              </Button>
            )}
          </nav>
        )}
        <div className={styles.headerEnd}>
          <ThemeToggle />
          <ButtonLink href="/exomem/home" variant="ghost">
            Home
          </ButtonLink>
        </div>
      </header>
      {moreRelations && map && (
        <section className={styles.relationMenu} role="dialog" aria-label="Relation types">
          <div className={styles.panelTitle}>
            <h2>Relations in this view · {map.vocabulary.length}</h2>
            <Button variant="ghost" onClick={() => setMoreRelations(false)}>
              Close
            </Button>
          </div>
          {map.vocabulary.map(chip)}
        </section>
      )}
      {reach === "signed_out" ? (
        <section className={styles.empty}>
          <Mark state="off" />
          <h1>Sign in to see your notes</h1>
          <ButtonLink href="/exomem/sign-in">Sign in</ButtonLink>
        </section>
      ) : !map ? (
        <section className={styles.empty}>
          <Mark state={reach === "loading" ? "progress" : "off"} />
          <h1>{reach === "loading" ? "Opening your knowledge" : "Can’t reach Exomem."}</h1>
          {reach === "lost" && (
            <>
              <p>Your memories are safe. We’ll try again.</p>
              <Button onClick={() => void refreshMap()}>Try now</Button>
            </>
          )}
        </section>
      ) : (
        <>
          {reach === "lost" && (
            <div className={styles.banner}>
              Can’t reach Exomem. Showing the view from {asOf(map.observed_at)}.{" "}
              <Button variant="ghost" onClick={() => void refreshMap()}>
                Try now
              </Button>
            </div>
          )}
          <div
            className={`${styles.workspace} ${reader ? styles.reading : ""} ${emptyVault ? styles.emptyWorkspace : ""} ${sheetOpen ? styles.sheetOpen : ""}`}
          >
            {reader ? (
              <section className={styles.reader} aria-label="Note reader">
                <div className={styles.readerBar}>
                  <Button variant="ghost" onClick={closeReader}>
                    ← map
                  </Button>
                  <span>{reader.note?.path}</span>
                  {reader.note && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(reader.note!.path)
                          .then(() => setCopied(true))
                          .catch(() => setCopied(false));
                      }}
                    >
                      <Swap k={copied ? "copied" : "copy"}>
                        {copied ? "Copied ✓" : "Copy path"}
                      </Swap>
                    </Button>
                  )}
                </div>
                <FadeIn key={reader.ref}>
                  <article className={styles.article}>
                    {reader.note ? (
                      <>
                        <h1 ref={readerHeading} tabIndex={-1}>
                          {title}
                        </h1>
                        <NoteMarkdown body={reader.note.body} title={title} onRead={openNote} />
                      </>
                    ) : reader.lost ? (
                      <>
                        <h1>Can’t open this note right now</h1>
                        <p>The note may be out of reach or no longer available to this view.</p>
                        <Button onClick={() => openNote(reader.ref)}>Try now</Button>
                      </>
                    ) : (
                      <>
                        <Mark state="progress" />
                        <h1>Opening the note…</h1>
                      </>
                    )}
                  </article>
                </FadeIn>
              </section>
            ) : map.nodes.length === 0 ? (
              <section className={styles.empty}>
                <Mark />
                <h1>
                  {map.state === "partial"
                    ? "No notes in this view yet"
                    : "Your knowledge starts here"}
                </h1>
                <p>
                  {map.state === "partial"
                    ? "This view is incomplete. Try again, or search for a note."
                    : "Save something through your assistant. It will appear here."}
                </p>
              </section>
            ) : (
              <MapSurface
                map={map}
                selected={selected?.node_key ?? null}
                hidden={hidden}
                held={held}
                paused={paused}
                onPick={pick}
              >
                <footer className={styles.footer}>
                  <span>
                    {map.counts.drawn_nodes.toLocaleString()} shown
                    {map.counts.eligible_nodes === null
                      ? " · total unknown"
                      : ` of ${map.counts.eligible_nodes.toLocaleString()} notes`}
                    {map.state === "partial" ? " · partial view" : ""}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => setPaused((current) => !current)}
                    aria-pressed={paused}
                  >
                    {paused ? "Resume motion" : "Pause motion"}
                  </Button>
                </footer>
              </MapSurface>
            )}
            {!emptyVault && (
              <aside
                className={styles.panel}
                aria-label={selected ? "Around this note" : "Knowledge overview"}
              >
                <PhoneSheet
                  desktopPanel
                  open={sheetOpen}
                  onToggle={() => setSheetOpen((open) => !open)}
                >
                  <div className={styles.panelContent} data-note={Boolean(selected)}>
                    {selected ? (
                      <FadeIn key={selected.node_key}>
                        <div className={styles.panelTitle}>
                          <TagChip>{selected.page_type ?? "Note"}</TagChip>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              setSelected(null);
                              previewRequest.current += 1;
                              setPreview(null);
                              closeReader();
                            }}
                          >
                            ← overview
                          </Button>
                        </div>
                        <h2>{selected.title || selected.path}</h2>
                        <p className={styles.summary}>
                          {preview?.note
                            ? previewSummary || "Read the note to see its content."
                            : preview?.lost
                              ? "Preview is out of reach."
                              : "Opening preview…"}
                        </p>
                        {!reader && (
                          <div className={styles.noteActions}>
                            <Button
                              variant="primary"
                              onClick={() => openNote(selected.memory_ref ?? selected.path)}
                            >
                              Read the note →
                            </Button>
                            <Button onClick={() => setSheetOpen(true)} title="Links in this view">
                              Links · {related.length}
                            </Button>
                          </div>
                        )}
                        <p className={styles.path}>{selected.path}</p>
                        {selected.updated_date && (
                          <p className={styles.meta}>Updated {selected.updated_date}</p>
                        )}
                        <h3>Links in this view · {related.length}</h3>
                        {related.map((edge) => {
                          const other = map.nodes.find(
                            (node) =>
                              node.node_key ===
                              (edge.src_key === selected.node_key ? edge.dst_key : edge.src_key)
                          );
                          if (!other) return null;
                          return (
                            <button
                              key={edge.edge_key}
                              type="button"
                              className={styles.row}
                              onClick={() => pick(other)}
                            >
                              <span>{edge.relation_identity.definition_key}</span>
                              {other.title || other.path}
                            </button>
                          );
                        })}
                        {map.state === "partial" && (
                          <p className={styles.meta}>Other links may be outside this view.</p>
                        )}
                      </FadeIn>
                    ) : (
                      <FadeIn>
                        <p className={styles.meta}>As of {asOf(map.observed_at)}</p>
                        <h1>Your knowledge</h1>
                        <dl className={styles.stats}>
                          <div>
                            <dt>Notes</dt>
                            <dd>{map.counts.eligible_nodes?.toLocaleString() ?? "Unknown"}</dd>
                          </div>
                          <div>
                            <dt>Links</dt>
                            <dd>{map.counts.eligible_edges?.toLocaleString() ?? "Unknown"}</dd>
                          </div>
                        </dl>
                        <h3>
                          {map.ranking_complete ? "Most connected" : "Most connected in this view"}
                        </h3>
                        {map.nodes.slice(0, 4).map((note) => (
                          <button
                            key={note.node_key}
                            type="button"
                            className={styles.row}
                            onClick={() => pick(note)}
                          >
                            {note.title || note.path}
                            <span>
                              {note.incoming_edges === null
                                ? "Unknown"
                                : `${note.incoming_edges} incoming ${note.incoming_edges === 1 ? "link" : "links"}`}
                            </span>
                          </button>
                        ))}
                        <p className={styles.help}>
                          Scroll to zoom, drag to move. Pick a note to read it and see its links.
                        </p>
                      </FadeIn>
                    )}
                  </div>
                </PhoneSheet>
              </aside>
            )}
          </div>
        </>
      )}
      <div className={styles.announcement} role="status" aria-live="polite">
        {reach === "lost"
          ? "Can’t reach Exomem."
          : reader?.lost
            ? "The note is unavailable."
            : searchState === "done" && query
              ? `${search?.hits.length ?? 0} search results in this answer.`
              : ""}
      </div>
    </main>
  );
}
