/**
 * The monthly ranking: one Anthropic Messages API call with a structured-output
 * schema (`send-monthly-whats-new-digest`, D2). Substrate's first model call.
 *
 * Plain `fetch`, not the SDK: one call a month needs a URL, three headers and
 * a body, the stand-in server of the tests speaks the same HTTP, and the SDK
 * would add a dependency for a request this size. The request follows
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 * and https://platform.claude.com/docs/en/api/versioning (version
 * 2026-10-21, which has no `temperature`).
 *
 * The model returns identifiers only. The email shows each note's own text.
 */

import { createHash } from "node:crypto";
import { resolveSelection, type MonthNote, type NoteId } from "./notes";
import type { WhatsNewDigestConfig } from "./config";
import { timeoutWithin } from "./time-budget";

/** The digest's bar (design D2): a month with fewer qualifying changes sends nothing. */
export const MIN_PICKS = 3;
export const MAX_PICKS = 6;

const API_VERSION = "2026-10-21";
const ATTEMPT_TIMEOUT_MS = 25_000;
/** Ranking a month takes seconds; an attempt with less than this left would only time out. */
const MIN_ATTEMPT_MS = 15_000;
const MAX_RESPONSE_TOKENS = 1024;
const RETRY_DELAY_MS = 2_000;

const SYSTEM_PROMPT = [
  "You help choose what a monthly product update email tells owners of Evermatter, a personal memory service that an AI assistant uses on the owner's behalf.",
  "You receive every user-visible change of one month. Each is a release version, a position in that release, an optional short title and one sentence.",
  `Pick the ${MIN_PICKS} to ${MAX_PICKS} changes that a typical owner is most likely to notice and use, most noticeable first.`,
  `Pick none when fewer than ${MIN_PICKS} changes would interest a typical owner. Return an empty list then.`,
  "Pick only changes from the list, each once, named by its release version and position. Never invent or reword a change.",
].join("\n");

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          version: { type: "string" },
          position: { type: "integer" },
        },
        required: ["version", "position"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
} as const;

export type RankingOutcome =
  /**
   * `picks` is the model's ranked answer: none, or 3 to 6 notes. `modelId` is the
   * name configuration asked for; `modelReported` is the model the API says answered.
   */
  | {
      kind: "ranked";
      picks: NoteId[];
      modelId: string;
      modelReported: string;
      promptVersion: string;
    }
  | { kind: "not_configured" }
  | { kind: "unavailable" }
  /** The run's time budget could not cover an attempt, so no call was made: not a model outage. */
  | { kind: "out_of_time" };

type Fetch = typeof fetch;

function notesPrompt(notes: readonly MonthNote[]): string {
  return notes
    .map(
      (note) =>
        `release ${note.version}, position ${note.position}: ${note.title ? `${note.title}. ` : ""}${note.text}`
    )
    .join("\n");
}

/** The schema cannot bound a list's length, so the cap is applied to the ranked list here. */
function capPicks(ids: NoteId[]): NoteId[] {
  return ids.slice(0, MAX_PICKS);
}

/** The bar is the digest's own rule; a list below it is the model's "none". */
function applyBar(ranked: NoteId[]): NoteId[] {
  return ranked.length < MIN_PICKS ? [] : ranked;
}

/**
 * Everything that decides what a ranking says, as data: the system prompt, the
 * output schema, the note line format (read off two sample notes through the
 * real formatter), the request's API version and token limit, and what the
 * answer's post-processing does (read off two sample answers through the real
 * cap and bar: one past the cap, one under the bar).
 */
export function promptIdentityParts() {
  const noteLines = notesPrompt([
    { version: "1.2.3", position: 0, title: "A title", text: "A sentence." },
    { version: "1.2.3", position: 1, title: null, text: "A sentence alone." },
  ]);
  const sampleIds = (count: number): NoteId[] =>
    Array.from({ length: count }, (_, position) => ({ version: "1.2.3", position }));
  return {
    system: SYSTEM_PROMPT,
    schema: RESPONSE_SCHEMA,
    noteLines,
    apiVersion: API_VERSION,
    maxTokens: MAX_RESPONSE_TOKENS,
    answerRules: [
      applyBar(capPicks(sampleIds(MAX_PICKS + 2))),
      applyBar(capPicks(sampleIds(MIN_PICKS - 1))),
    ],
  };
}

/**
 * The prompt's identity: a hash of `promptIdentityParts`. A change to any part
 * changes the hash, and a changed hash restarts the measurement's count, so no
 * version number is kept by hand.
 */
export function promptVersionOf(
  parts: ReturnType<typeof promptIdentityParts> = promptIdentityParts()
): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

export const WHATS_NEW_PROMPT_VERSION = promptVersionOf();

class AttemptFailed extends Error {
  constructor(readonly retryable: boolean) {
    super("ranking attempt failed");
  }
}

class OutOfTime extends Error {}

/** One answer from the model, read through the schema and checked against the month's notes. */
function readAnswer(
  body: unknown,
  notes: readonly MonthNote[]
): { picks: NoteId[]; modelReported: string } {
  const message = body as { stop_reason?: unknown; content?: unknown; model?: unknown } | null;
  // A refusal or a cut-off answer may not match the schema; neither is an answer.
  if (!message || message.stop_reason === "refusal" || message.stop_reason === "max_tokens") {
    throw new AttemptFailed(true);
  }
  // The measurement compares the model that answered, so an answer that does not say which is no answer.
  if (typeof message.model !== "string" || message.model === "") throw new AttemptFailed(true);
  const text = Array.isArray(message.content)
    ? (message.content as Array<{ type?: unknown; text?: unknown }>).find(
        (block) => block.type === "text"
      )?.text
    : undefined;
  if (typeof text !== "string") throw new AttemptFailed(true);
  let answer: { picks?: unknown };
  try {
    answer = JSON.parse(text) as { picks?: unknown };
  } catch {
    throw new AttemptFailed(true);
  }
  if (!Array.isArray(answer.picks)) throw new AttemptFailed(true);
  const ids = (answer.picks as Array<{ version?: unknown; position?: unknown }>).map((pick) => ({
    version: String(pick?.version),
    position: Number(pick?.position),
  }));
  const ranked = capPicks(ids);
  // An identifier that names no note of the month, or names one twice, is a bad answer, not "none".
  if (!resolveSelection(notes, ranked)) throw new AttemptFailed(true);
  return { picks: applyBar(ranked), modelReported: message.model };
}

async function attempt(
  notes: readonly MonthNote[],
  config: WhatsNewDigestConfig,
  apiKey: string,
  fetchImpl: Fetch,
  deadlineAt: number | undefined
): Promise<{ picks: NoteId[]; modelReported: string }> {
  // An attempt gets its full timeout or what the run's budget leaves; one that
  // the budget cannot give a useful part of is not started (the next daily run tries).
  const timeout = timeoutWithin(deadlineAt, ATTEMPT_TIMEOUT_MS, MIN_ATTEMPT_MS);
  if (timeout === null) throw new OutOfTime();
  let response: Response;
  try {
    response = await fetchImpl(
      new URL("v1/messages", `${config.anthropicBaseUrl.replace(/\/+$/, "")}/`),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({
          model: config.modelId,
          max_tokens: MAX_RESPONSE_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: notesPrompt(notes) }],
          output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
        }),
        signal: AbortSignal.timeout(timeout),
      }
    );
  } catch {
    throw new AttemptFailed(true);
  }
  if (!response.ok) {
    // A rate limit, an overload or a server error may pass; a rejected request or key will not.
    throw new AttemptFailed(response.status === 429 || response.status >= 500);
  }
  try {
    return readAnswer(await response.json(), notes);
  } catch (error) {
    throw error instanceof AttemptFailed ? error : new AttemptFailed(true);
  }
}

/**
 * Ranks a month's notes. With no key configured no call is made. A failed
 * attempt that may pass is tried once more; any failure leaves the month
 * waiting for the next daily run.
 */
export async function rankMonthNotes(
  notes: readonly MonthNote[],
  config: WhatsNewDigestConfig,
  options: { fetchImpl?: Fetch; retryDelayMs?: number; deadlineAt?: number } = {}
): Promise<RankingOutcome> {
  if (!config.anthropicApiKey) return { kind: "not_configured" };
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const answer = await attempt(
        notes,
        config,
        config.anthropicApiKey,
        fetchImpl,
        options.deadlineAt
      );
      return {
        kind: "ranked",
        picks: answer.picks,
        modelId: config.modelId,
        modelReported: answer.modelReported,
        promptVersion: WHATS_NEW_PROMPT_VERSION,
      };
    } catch (error) {
      if (error instanceof OutOfTime)
        return tries === 0 ? { kind: "out_of_time" } : { kind: "unavailable" };
      if (!(error instanceof AttemptFailed) || !error.retryable || tries === 1) break;
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? RETRY_DELAY_MS));
    }
  }
  return { kind: "unavailable" };
}
