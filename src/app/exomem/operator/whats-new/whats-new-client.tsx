"use client";

import { FormEvent, useRef, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Switch } from "@/components/exomem/Switch";
import { TextField } from "@/components/exomem/TextField";
import type { DigestOverview, MonthDetail } from "@/lib/exomem-hosted/whats-new-digest/approval";
import { MAX_PICKS, MIN_PICKS } from "@/lib/exomem-hosted/whats-new-digest/pick-bounds";
import { isOpenState } from "@/lib/exomem-hosted/whats-new-digest/states";
import home from "../../home/home.module.css";
import { OperatorHeader } from "../operator-header";
import { OperatorRequestError, operatorRequest } from "../operator-request";
import {
  monthTitle,
  moved,
  noteKey,
  noteRef,
  requestMessage,
  listedState,
  lockedReason,
  measurementFigures,
  measurementRule,
  monthFigures,
  selectionAllowed,
  setupFigures,
  stateLabel,
  switchFigure,
  timeLabel,
  toggled,
  type Figure,
  type NoteRef,
  type NoteView,
} from "./whats-new-state";
import styles from "./whats-new.module.css";

const ENDPOINT = "/api/exomem/admin/whats-new-digest";

/**
 * One note. `check` is a checkbox: the whole row becomes its label, so a tap anywhere on the note
 * picks it. `actions` sit after the text and wrap under it when the row is narrow, so a phone
 * keeps the note's full width.
 */
function NoteLine({
  note,
  check,
  actions,
}: {
  note: NoteView;
  check?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const body = (
    <span className={styles.noteBody}>
      {note.title ? <span className={styles.noteTitle}>{note.title}</span> : null}
      <span className={styles.noteText}>{note.text}</span>
      <span className={styles.noteMeta}>
        {note.version} · note {note.position + 1}
      </span>
    </span>
  );
  return (
    <li className={styles.note}>
      {check ? (
        <label className={styles.noteLabel}>
          {check}
          {body}
        </label>
      ) : (
        body
      )}
      {actions ? <span className={styles.noteActions}>{actions}</span> : null}
    </li>
  );
}

const refs = (notes: readonly NoteView[]): NoteRef[] => notes.map(noteRef);

/** Labelled values, one row each: the page states a value with its label, not in a sentence. */
function FigureRows({ figures }: { figures: readonly Figure[] }) {
  return figures.map((figure) => (
    <div className={`${home.row} ${styles.figureRow}`} key={figure.label}>
      <dt className={home.rowTitle}>{figure.label}</dt>
      <dd className={styles.figure}>{figure.value}</dd>
    </div>
  ));
}

export default function WhatsNewClient() {
  const bearerRef = useRef<string | null>(null);
  const [bearer, setBearer] = useState("");
  const [overview, setOverview] = useState<DigestOverview | null>(null);
  const [month, setMonth] = useState<MonthDetail | null>(null);
  const [pick, setPick] = useState<NoteRef[]>([]);
  const [editing, setEditing] = useState<NoteRef[] | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  function fail(requestError: unknown) {
    if (requestError instanceof OperatorRequestError && requestError.status === 401) lock();
    setError(true);
    setMessage(
      requestError instanceof OperatorRequestError
        ? requestMessage(requestError.code)
        : "The request failed. Try again."
    );
  }

  function lock() {
    bearerRef.current = null;
    setOverview(null);
    setMonth(null);
    setPick([]);
    setEditing(null);
    setBearer("");
  }

  async function openMonth(name: string, activeBearer: string) {
    const body = await operatorRequest(
      `${ENDPOINT}?month=${encodeURIComponent(name)}`,
      activeBearer
    );
    setMonth(body.month as MonthDetail);
    setPick([]);
    setEditing(null);
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = bearer.trim();
    if (!candidate || working) return;
    setWorking(true);
    setError(false);
    setMessage("");
    try {
      const body = await operatorRequest(ENDPOINT, candidate);
      const loaded = body.overview as DigestOverview;
      bearerRef.current = candidate;
      setBearer("");
      setOverview(loaded);
      // The page opens on the newest month that still waits for the operator, else the newest.
      const waiting = loaded.months.find((entry) => isOpenState(entry.state));
      const first = waiting ?? loaded.months[0];
      if (first) await openMonth(first.month, candidate);
    } catch (requestError) {
      bearerRef.current = null;
      fail(requestError);
    } finally {
      setWorking(false);
    }
  }

  /** One operator action; the answer is the month's new detail, or the overview for the switch. */
  async function send(payload: Record<string, unknown>, done: string) {
    const activeBearer = bearerRef.current;
    if (!activeBearer || working) return;
    setWorking(true);
    setError(false);
    setMessage("");
    try {
      const body = await operatorRequest(ENDPOINT, activeBearer, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (body.month) {
        setMonth(body.month as MonthDetail);
        setPick([]);
        setEditing(null);
      }
      const refreshed = await operatorRequest(ENDPOINT, activeBearer);
      setOverview(refreshed.overview as DigestOverview);
      setMessage(done);
    } catch (requestError) {
      fail(requestError);
    } finally {
      setWorking(false);
    }
  }

  if (!overview) {
    return (
      <>
        <OperatorHeader current="whats-new" />
        <section className={home.column} aria-labelledby="whats-new-auth-title">
          <div className={home.statusText}>
            <h1 className={home.headline} id="whats-new-auth-title">
              Monthly What&rsquo;s new.
            </h1>
            <span className={home.statusLine}>
              Enter the existing Evermatter admin bearer. It stays only in this page and is
              discarded on refresh.
            </span>
          </div>
          <form className={styles.form} onSubmit={authenticate}>
            <TextField
              label="Admin bearer"
              type="password"
              value={bearer}
              onChange={(event) => setBearer(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              invalid={error}
            />
            <div>
              <Button
                variant="primary"
                size="page"
                type="submit"
                disabled={!bearer.trim()}
                working={working}
              >
                {working ? "Checking…" : "Open the digest"}
              </Button>
              <p
                className={home.billingStatus}
                role={error ? "alert" : "status"}
                aria-live="polite"
              >
                {message}
              </p>
            </div>
          </form>
        </section>
      </>
    );
  }

  // The server's clock when it last answered, not this device's: the stop window is the server's to judge.
  const now = Date.parse(month?.at ?? overview.at);
  const waiting = month !== null && isOpenState(month.state);
  const decidable = month?.state === "awaiting_approval" && month.blindPick !== null;
  const shares = overview.measurement;
  const missingVersions = month?.releases.missing.map((release) => release.version) ?? [];
  const remaining = month
    ? month.notes.filter((note) => !(editing ?? []).some((e) => noteKey(e) === noteKey(note)))
    : [];
  const byKey = new Map((month?.notes ?? []).map((note) => [noteKey(note), note]));
  // A recorded switch that no longer matches the ranking's identity is not in effect: only clearing it is offered.
  const switchStale = overview.switch.sendWithoutApproval && !overview.switch.applies;
  const switchOffered = !switchStale && (shares.offered || overview.switch.sendWithoutApproval);

  return (
    <>
      <OperatorHeader current="whats-new" onLock={lock} />
      <div className={`${home.column} ${styles.column}`}>
        <h1 className={home.headline}>Monthly What&rsquo;s new.</h1>
        <p className={home.billingStatus} role={error ? "alert" : "status"} aria-live="polite">
          {message}
        </p>

        <section className={home.section} aria-labelledby="digest-months-title">
          <h2 className={home.sectionTitle} id="digest-months-title">
            Months
          </h2>
          <dl className={home.panel}>
            {overview.months.length === 0 ? (
              <div className={`${home.row} ${styles.figureRow}`}>
                <dt className={home.rowTitle}>No month yet</dt>
              </div>
            ) : (
              overview.months.map((entry) => (
                <div className={`${home.row} ${styles.monthRow}`} key={entry.month}>
                  <dt className={home.rowTitle}>{monthTitle(entry.month)}</dt>
                  <dd className={styles.monthActions}>
                    <span className={`${styles.noteMeta} ${styles.monthState}`}>
                      {listedState(entry, now)}
                    </span>
                    <Button
                      size="detail"
                      disabled={working || month?.month === entry.month}
                      onClick={() => {
                        const active = bearerRef.current;
                        if (active) openMonth(entry.month, active).catch(fail);
                      }}
                    >
                      {month?.month === entry.month ? "Open" : "Open month"}
                    </Button>
                  </dd>
                </div>
              ))
            )}
          </dl>
        </section>

        <section className={home.section} aria-labelledby="digest-setup-title">
          <h2 className={home.sectionTitle} id="digest-setup-title">
            Setup
          </h2>
          <dl className={home.panel}>
            <FigureRows figures={setupFigures(overview)} />
          </dl>
        </section>

        {month ? (
          <>
            <section className={home.section} aria-labelledby="digest-month-title">
              <h2 className={home.sectionTitle} id="digest-month-title">
                {monthTitle(month.month)}
              </h2>
              <dl className={home.panel}>
                <FigureRows
                  figures={[
                    { label: "State", value: stateLabel(month, overview.modelConfigured, now) },
                    ...monthFigures(month),
                  ]}
                />
              </dl>
            </section>

            {month.releases.missing.length > 0 ? (
              <section className={home.section} aria-labelledby="digest-missing-title">
                <h2 className={home.sectionTitle} id="digest-missing-title">
                  Releases without notes
                </h2>
                <details className={`${home.panel} ${styles.body}`}>
                  <summary>
                    {month.releases.missing.length}{" "}
                    {month.releases.missing.length === 1 ? "release" : "releases"}
                  </summary>
                  <ul className={styles.noteList}>
                    {month.releases.missing.map((release) => (
                      <li className={styles.note} key={release.version}>
                        <span className={styles.noteBody}>
                          <span className={styles.noteTitle}>{release.version}</span>
                          <span className={styles.noteMeta}>
                            {release.problem === "no_asset"
                              ? "No notes file"
                              : release.problem === "unreadable"
                                ? "Not in the notes format"
                                : "Not fetched yet"}
                          </span>
                        </span>
                        <Button
                          size="detail"
                          disabled={working}
                          onClick={() =>
                            send(
                              {
                                action: "accept_missing",
                                month: month.month,
                                versions: [release.version],
                              },
                              `Accepted without ${release.version}.`
                            )
                          }
                        >
                          Accept without
                        </Button>
                      </li>
                    ))}
                  </ul>
                  {month.releases.missing.length > 1 ? (
                    <div className={styles.rowActions}>
                      <Button
                        disabled={working}
                        onClick={() =>
                          send(
                            {
                              action: "accept_missing",
                              month: month.month,
                              versions: missingVersions,
                            },
                            `Accepted without ${missingVersions.length} releases.`
                          )
                        }
                      >
                        Accept without all {missingVersions.length}
                      </Button>
                    </div>
                  ) : null}
                </details>
              </section>
            ) : null}

            {month.canPickBlind ? (
              <section className={home.section} aria-labelledby="digest-blind-title">
                <h2 className={home.sectionTitle} id="digest-blind-title">
                  Your pick
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  <ul className={`${styles.noteList} ${styles.scroll}`}>
                    {month.notes.map((note) => (
                      <NoteLine
                        note={note}
                        key={noteKey(note)}
                        check={
                          <input
                            className={styles.check}
                            type="checkbox"
                            aria-label={`Pick ${note.title ?? note.text}`}
                            checked={pick.some((entry) => noteKey(entry) === noteKey(note))}
                            disabled={
                              working ||
                              (pick.length >= MAX_PICKS &&
                                !pick.some((entry) => noteKey(entry) === noteKey(note)))
                            }
                            onChange={() => setPick(toggled(pick, note))}
                          />
                        }
                      />
                    ))}
                  </ul>
                  <div className={styles.rowActions}>
                    <Button
                      variant="primary"
                      disabled={working || !selectionAllowed(pick.length, true)}
                      onClick={() =>
                        send(
                          { action: "blind_pick", month: month.month, selection: pick },
                          pick.length === 0
                            ? "Recorded: none. The month is skipped."
                            : `Recorded: ${pick.length} notes.`
                        )
                      }
                    >
                      {pick.length === 0
                        ? "Pick none and skip the month"
                        : `Record my ${pick.length} picks`}
                    </Button>
                    <span className={styles.noteMeta}>
                      {pick.length} picked, {MIN_PICKS} to {MAX_PICKS} or none
                    </span>
                  </div>
                </div>
              </section>
            ) : month.blindPick !== null ? (
              <section className={home.section} aria-labelledby="digest-yours-title">
                <h2 className={home.sectionTitle} id="digest-yours-title">
                  Your pick
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  {month.blindPick.length === 0 ? (
                    <p className={styles.line}>None picked</p>
                  ) : (
                    <ul className={styles.noteList}>
                      {month.blindPick.flatMap((entry) => {
                        const note = byKey.get(noteKey(entry));
                        return note ? [<NoteLine note={note} key={noteKey(entry)} />] : [];
                      })}
                    </ul>
                  )}
                </div>
              </section>
            ) : null}

            {month.model ? (
              <>
                <section className={home.section} aria-labelledby="digest-model-title">
                  <h2 className={home.sectionTitle} id="digest-model-title">
                    The model&rsquo;s selection
                  </h2>
                  <div className={`${home.panel} ${styles.body}`}>
                    {month.model.selection.length === 0 ? (
                      <p className={styles.line}>None selected</p>
                    ) : (
                      <ol className={styles.noteList}>
                        {month.model.selection.map((note) => (
                          <NoteLine note={note} key={noteKey(note)} />
                        ))}
                      </ol>
                    )}
                  </div>
                </section>

                <section className={home.section} aria-labelledby="digest-left-title">
                  <h2 className={home.sectionTitle} id="digest-left-title">
                    Notes left out
                  </h2>
                  <details className={`${home.panel} ${styles.body}`}>
                    <summary>
                      {month.model.leftOut.length}{" "}
                      {month.model.leftOut.length === 1 ? "note" : "notes"}
                    </summary>
                    {/* The list scrolls, so a keyboard needs a way in: the region takes focus and has a name. */}
                    <div
                      className={styles.scroll}
                      role="region"
                      aria-label="Notes left out"
                      tabIndex={0}
                    >
                      <ul className={styles.noteList}>
                        {month.model.leftOut.map((note) => (
                          <NoteLine note={note} key={noteKey(note)} />
                        ))}
                      </ul>
                    </div>
                  </details>
                </section>
              </>
            ) : null}

            {month.email ? (
              <section className={home.section} aria-labelledby="digest-email-title">
                <h2 className={home.sectionTitle} id="digest-email-title">
                  The email
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  <p className={styles.line}>Subject: {month.email.subject}</p>
                  <div className={styles.frames}>
                    <div>
                      <p className={styles.frameLabel}>Light</p>
                      <iframe
                        className={styles.frame}
                        title="The email in light"
                        sandbox=""
                        srcDoc={month.email.light}
                      />
                    </div>
                    <div>
                      <p className={styles.frameLabel}>Dark</p>
                      <iframe
                        className={styles.frame}
                        title="The email in dark"
                        sandbox=""
                        srcDoc={month.email.dark}
                      />
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            {month.finalSelection ? (
              <section className={home.section} aria-labelledby="digest-final-title">
                <h2 className={home.sectionTitle} id="digest-final-title">
                  Final selection
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  <ol className={styles.noteList}>
                    {month.finalSelection.map((note) => (
                      <NoteLine note={note} key={noteKey(note)} />
                    ))}
                  </ol>
                </div>
              </section>
            ) : null}

            {month.canStop ? (
              <section className={home.section} aria-labelledby="digest-stop-title">
                <h2 className={home.sectionTitle} id="digest-stop-title">
                  Stop this month
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  {month.sendAfter && Date.parse(month.sendAfter) > now ? (
                    <p className={styles.line}>Queues after {timeLabel(month.sendAfter)}</p>
                  ) : null}
                  <div className={styles.rowActions}>
                    <Button
                      disabled={working}
                      title="Stopping skips the month. Digests waiting in the outbox are cancelled when they would send; any already sent stay sent."
                      onClick={() => send({ action: "stop", month: month.month }, "Stopped.")}
                    >
                      Stop sending this month
                    </Button>
                  </div>
                </div>
              </section>
            ) : null}

            {waiting ? (
              <section className={home.section} aria-labelledby="digest-decide-title">
                <h2 className={home.sectionTitle} id="digest-decide-title">
                  Decision
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  {editing ? (
                    <>
                      <ol className={styles.noteList}>
                        {editing.map((entry, index) => {
                          const note = byKey.get(noteKey(entry));
                          return note ? (
                            <NoteLine
                              note={note}
                              key={noteKey(entry)}
                              actions={
                                <>
                                  <Button
                                    size="detail"
                                    disabled={working || index === 0}
                                    onClick={() => setEditing(moved(editing, index, -1))}
                                  >
                                    Up
                                  </Button>
                                  <Button
                                    size="detail"
                                    disabled={working || index === editing.length - 1}
                                    onClick={() => setEditing(moved(editing, index, 1))}
                                  >
                                    Down
                                  </Button>
                                  <Button
                                    size="detail"
                                    disabled={working}
                                    onClick={() =>
                                      setEditing(
                                        editing.filter((e) => noteKey(e) !== noteKey(entry))
                                      )
                                    }
                                  >
                                    Remove
                                  </Button>
                                </>
                              }
                            />
                          ) : null;
                        })}
                      </ol>
                      {editing.length < MAX_PICKS ? (
                        <select
                          className={styles.select}
                          aria-label="Add a note"
                          value=""
                          disabled={working}
                          onChange={(event) => {
                            const chosen = remaining.find(
                              (note) => noteKey(note) === event.target.value
                            );
                            if (chosen) setEditing([...editing, noteRef(chosen)]);
                          }}
                        >
                          <option value="">Add a note…</option>
                          {remaining.map((note) => (
                            <option key={noteKey(note)} value={noteKey(note)}>
                              {note.title ?? note.text}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <div className={styles.rowActions}>
                        <Button
                          variant="primary"
                          disabled={working || !selectionAllowed(editing.length, false)}
                          onClick={() =>
                            send(
                              { action: "edit", month: month.month, selection: editing },
                              "Approved with your edit."
                            )
                          }
                        >
                          Approve the edited selection
                        </Button>
                        <Button disabled={working} onClick={() => setEditing(null)}>
                          Cancel the edit
                        </Button>
                        <span className={styles.noteMeta}>
                          {editing.length} selected, {MIN_PICKS} to {MAX_PICKS}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className={styles.rowActions}>
                      <Button
                        variant="primary"
                        disabled={
                          working || !decidable || (month.model?.selection.length ?? 0) < MIN_PICKS
                        }
                        onClick={() =>
                          send({ action: "approve", month: month.month }, "Approved as ranked.")
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        disabled={working || !decidable}
                        onClick={() => setEditing(refs(month.model?.selection ?? []))}
                      >
                        Edit
                      </Button>
                      <Button
                        disabled={working}
                        onClick={() => send({ action: "skip", month: month.month }, "Skipped.")}
                      >
                        Skip the month
                      </Button>
                    </div>
                  )}
                  {!decidable && !editing ? (
                    <p className={styles.line}>{lockedReason(month)}</p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </>
        ) : null}

        <section className={home.section} aria-labelledby="digest-measure-title">
          <h2
            className={home.sectionTitle}
            id="digest-measure-title"
            title={measurementRule(shares.monthsToMeasure)}
          >
            Measurement
          </h2>
          <div className={`${home.panel} ${styles.body}`}>
            <dl>
              <FigureRows figures={measurementFigures(shares)} />
              {shares.run.map((share) => (
                <div className={`${home.row} ${styles.figureRow}`} key={share.month}>
                  <dt className={home.rowTitle}>{monthTitle(share.month)}</dt>
                  <dd className={styles.figure}>
                    {share.both} of {Math.max(share.operatorPicks, share.modelPicks)} (you{" "}
                    {share.operatorPicks}, model {share.modelPicks})
                    {share.passes ? " · two thirds or more" : " · under two thirds"}
                    {shares.measured.some((measured) => measured.month === share.month)
                      ? ""
                      : " · not measured"}
                  </dd>
                </div>
              ))}
              {switchOffered ? null : <FigureRows figures={[switchFigure(overview)]} />}
            </dl>
            {switchStale ? (
              <div className={styles.rowActions}>
                <Button
                  disabled={working}
                  onClick={() =>
                    send({ action: "set_switch", on: false }, "The recorded switch is cleared.")
                  }
                >
                  Clear the recorded switch
                </Button>
              </div>
            ) : switchOffered ? (
              <Switch
                label="Send later months without approval"
                checked={overview.switch.sendWithoutApproval}
                onChange={(on) => {
                  void send(
                    { action: "set_switch", on },
                    on ? "Approval is off." : "Approval is on."
                  );
                }}
              />
            ) : null}
          </div>
        </section>
      </div>
    </>
  );
}
