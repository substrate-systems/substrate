"use client";

import { FormEvent, useRef, useState } from "react";
import { Button } from "@/components/exomem/Button";
import { Switch } from "@/components/exomem/Switch";
import { TextField } from "@/components/exomem/TextField";
import type { DigestOverview, MonthDetail } from "@/lib/exomem-hosted/whats-new-digest/approval";
import { isOpenState } from "@/lib/exomem-hosted/whats-new-digest/states";
import home from "../../home/home.module.css";
import { OperatorHeader } from "../operator-header";
import { OperatorRequestError, operatorRequest } from "../operator-request";
import {
  MAX_NOTES,
  MIN_NOTES,
  monthTitle,
  moved,
  noteKey,
  noteRef,
  requestMessage,
  selectionAllowed,
  stateSentence,
  toggled,
  type NoteRef,
  type NoteView,
} from "./whats-new-state";
import styles from "./whats-new.module.css";

const ENDPOINT = "/api/exomem/admin/whats-new-digest";

function NoteLine({ note, children }: { note: NoteView; children?: React.ReactNode }) {
  return (
    <li className={styles.note}>
      {children}
      <span className={styles.noteBody}>
        {note.title ? <span className={styles.noteTitle}>{note.title}</span> : null}
        <span className={styles.noteText}>{note.text}</span>
        <span className={styles.noteMeta}>
          {note.version} · note {note.position + 1}
        </span>
      </span>
    </li>
  );
}

const refs = (notes: readonly NoteView[]): NoteRef[] => notes.map(noteRef);

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

  const waiting = month !== null && isOpenState(month.state);
  const decidable = month?.state === "awaiting_approval" && month.blindPick !== null;
  const shares = overview.measurement;
  const missingVersions = month?.releases.missing.map((release) => release.version) ?? [];
  const remaining = month
    ? month.notes.filter((note) => !(editing ?? []).some((e) => noteKey(e) === noteKey(note)))
    : [];
  const byKey = new Map((month?.notes ?? []).map((note) => [noteKey(note), note]));

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
              <div className={home.row}>
                <dt className={home.rowTitle}>No month yet</dt>
                <dd className={styles.figure}>The daily run builds the previous month.</dd>
              </div>
            ) : (
              overview.months.map((entry) => (
                <div className={home.row} key={entry.month}>
                  <dt className={home.rowTitle}>{monthTitle(entry.month)}</dt>
                  <dd className={styles.rowActions}>
                    <span className={styles.noteMeta}>{entry.state.replaceAll("_", " ")}</span>
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

        {month ? (
          <>
            <section className={home.section} aria-labelledby="digest-month-title">
              <h2 className={home.sectionTitle} id="digest-month-title">
                {monthTitle(month.month)}
              </h2>
              <div className={`${home.panel} ${styles.body}`}>
                <p className={styles.line}>{stateSentence(month, overview.modelConfigured)}</p>
                <p className={styles.line}>
                  {month.releases.total} {month.releases.total === 1 ? "release" : "releases"},{" "}
                  {month.notes.length} {month.notes.length === 1 ? "note" : "notes"}
                  {month.releases.acceptedWithout > 0
                    ? `, ${month.releases.acceptedWithout} accepted without notes`
                    : ""}
                  .
                  {month.modelId
                    ? ` Ranked by ${month.modelId}, prompt ${month.promptVersion}.`
                    : ""}
                </p>
              </div>
            </section>

            {month.releases.missing.length > 0 ? (
              <section className={home.section} aria-labelledby="digest-missing-title">
                <h2 className={home.sectionTitle} id="digest-missing-title">
                  Releases without notes
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  <p className={styles.line}>
                    The month does not send while a release has no readable notes. The daily run
                    tries again, or you accept the month without a release.
                  </p>
                  <ul className={styles.noteList}>
                    {month.releases.missing.map((release) => (
                      <li className={styles.note} key={release.version}>
                        <span className={styles.noteBody}>
                          <span className={styles.noteTitle}>{release.version}</span>
                          <span className={styles.noteMeta}>
                            {release.problem === "no_asset"
                              ? "no notes file attached"
                              : release.problem === "unreadable"
                                ? "the file is not in the notes format"
                                : "the file could not be fetched yet"}
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
                </div>
              </section>
            ) : null}

            {month.canPickBlind ? (
              <section className={home.section} aria-labelledby="digest-blind-title">
                <h2 className={home.sectionTitle} id="digest-blind-title">
                  Your pick
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  <p className={styles.line}>
                    Pick {MIN_NOTES} to {MAX_NOTES} notes that owners are most likely to notice, or
                    none to skip the month. You see the model&rsquo;s ranking after you record this,
                    and the pick cannot change afterwards.
                  </p>
                  <ul className={`${styles.noteList} ${styles.scroll}`}>
                    {month.notes.map((note) => (
                      <NoteLine note={note} key={noteKey(note)}>
                        <input
                          className={styles.check}
                          type="checkbox"
                          aria-label={`Pick ${note.title ?? note.text}`}
                          checked={pick.some((entry) => noteKey(entry) === noteKey(note))}
                          disabled={
                            working ||
                            (pick.length >= MAX_NOTES &&
                              !pick.some((entry) => noteKey(entry) === noteKey(note)))
                          }
                          onChange={() => setPick(toggled(pick, note))}
                        />
                      </NoteLine>
                    ))}
                  </ul>
                  <div className={styles.rowActions}>
                    <Button
                      variant="primary"
                      disabled={working || !selectionAllowed(pick.length, true)}
                      onClick={() =>
                        send(
                          { action: "blind_pick", month: month.month, selection: pick },
                          pick.length === 0 ? "Recorded: none." : `Recorded: ${pick.length} notes.`
                        )
                      }
                    >
                      {pick.length === 0 ? "Record none, skip" : `Record my ${pick.length} picks`}
                    </Button>
                    <span className={styles.noteMeta}>{pick.length} picked</span>
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
                    <p className={styles.line}>None. You picked no notes.</p>
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
                      <p className={styles.line}>
                        None. The model found fewer than {MIN_NOTES} notes that owners would notice.
                      </p>
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
                    <ul className={`${styles.noteList} ${styles.scroll}`}>
                      {month.model.leftOut.map((note) => (
                        <NoteLine note={note} key={noteKey(note)} />
                      ))}
                    </ul>
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

            {waiting ? (
              <section className={home.section} aria-labelledby="digest-decide-title">
                <h2 className={home.sectionTitle} id="digest-decide-title">
                  Decision
                </h2>
                <div className={`${home.panel} ${styles.body}`}>
                  {editing ? (
                    <>
                      <p className={styles.line}>
                        Remove, add or reorder, {MIN_NOTES} to {MAX_NOTES} notes. A note&rsquo;s
                        text never changes.
                      </p>
                      <ol className={styles.noteList}>
                        {editing.map((entry, index) => {
                          const note = byKey.get(noteKey(entry));
                          return note ? (
                            <NoteLine note={note} key={noteKey(entry)}>
                              <span className={styles.rowActions}>
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
                                    setEditing(editing.filter((e) => noteKey(e) !== noteKey(entry)))
                                  }
                                >
                                  Remove
                                </Button>
                              </span>
                            </NoteLine>
                          ) : null;
                        })}
                      </ol>
                      {editing.length < MAX_NOTES ? (
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
                      </div>
                    </>
                  ) : (
                    <div className={styles.rowActions}>
                      <Button
                        variant="primary"
                        disabled={
                          working || !decidable || (month.model?.selection.length ?? 0) < MIN_NOTES
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
                    <p className={styles.line}>
                      Approve and Edit unlock when the ranking is in and your own pick is recorded.
                    </p>
                  ) : null}
                </div>
              </section>
            ) : null}
          </>
        ) : null}

        <section className={home.section} aria-labelledby="digest-measure-title">
          <h2 className={home.sectionTitle} id="digest-measure-title">
            Measurement
          </h2>
          <div className={`${home.panel} ${styles.body}`}>
            <p className={styles.line}>
              {shares.run.length === 0
                ? "No approved month counts yet."
                : `${shares.run.length} counted ${shares.run.length === 1 ? "month" : "months"} under ${overview.model.modelId}, prompt ${overview.model.promptVersion}; the first ${shares.monthsToMeasure} decide.`}{" "}
              A month counts when you approved or edited it and it was not quiet. A change of model
              or prompt restarts the count.
            </p>
            <dl>
              {shares.run.map((share) => (
                <div className={home.row} key={share.month}>
                  <dt className={home.rowTitle}>{monthTitle(share.month)}</dt>
                  <dd className={styles.figure}>
                    {share.both} of {share.operatorPicks}
                    {share.passes ? " · two thirds or more" : " · under two thirds"}
                    {shares.measured.some((measured) => measured.month === share.month)
                      ? ""
                      : " · not measured"}
                  </dd>
                </div>
              ))}
            </dl>
            {shares.offered || overview.switch.sendWithoutApproval ? (
              <>
                <Switch
                  label="Send later months without approval"
                  description={
                    overview.switch.sendWithoutApproval && !overview.switch.applies
                      ? "Recorded, but the model or prompt changed since. Months need approval until a new measurement."
                      : undefined
                  }
                  checked={overview.switch.sendWithoutApproval}
                  onChange={(on) => {
                    void send(
                      { action: "set_switch", on },
                      on ? "Approval is off." : "Approval is on."
                    );
                  }}
                />
              </>
            ) : (
              <p className={styles.line}>
                {shares.complete
                  ? "At least one of the three months is under two thirds, so approval stays on."
                  : `Sending without approval is offered after ${shares.monthsToMeasure} counted months that each reach two thirds; ${Math.max(0, shares.monthsToMeasure - shares.measured.length)} to go.`}
              </p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
