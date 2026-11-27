/**
 * Stand-in servers for the digest's two outside services, spoken over real HTTP:
 * the GitHub releases API as Evermatter's repository answers it, and the
 * Anthropic Messages API. Their notes files are written in the format Evermatter
 * publishes (`release_notes_format.py`), not in a shape read back from the code
 * under test.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";

export type StandInNote = { title: string | null; text: string };

/** One release's `release-notes.json` as Evermatter writes it: its own entry, or none when it has no notes. */
export function notesFile(version: string, releasedOn: string, notes: StandInNote[]): string {
  return JSON.stringify({
    schema: 2,
    releases: notes.length === 0 ? [] : [{ version, released_on: releasedOn, notes }],
  });
}

export type StandInRelease = {
  version: string;
  createdAt: string;
  /** `null` is a draft's. */
  publishedAt: string | null;
  prerelease?: boolean;
  /** The notes asset's content; `undefined` is a release that attached none. */
  file?: string;
};

export type RequestLog = { url: string; headers: IncomingMessage["headers"]; body: string };

async function listen(
  handler: Parameters<typeof createServer>[1]
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stand-in has no port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

export type GitHubStandIn = {
  origin: string;
  releases: StandInRelease[];
  /** Every request the API and the storage host saw, in order; storage URLs start with "storage ". */
  requests: RequestLog[];
  /** How many times each release's notes asset was downloaded. */
  assetDownloads(version: string): number;
  close(): Promise<void>;
};

/**
 * The releases list answers newest created first and honours `per_page` and `page`. A notes asset
 * downloads through a redirect to a signed storage URL, as GitHub's does.
 */
export async function startGitHub(releases: StandInRelease[] = []): Promise<GitHubStandIn> {
  const requests: RequestLog[] = [];
  const state = { releases };
  const idOf = (version: string) => version.replaceAll(".", "-");
  // Signed storage is another host than the API, as GitHub's is: a client that sent its token
  // along the redirect would show here.
  const storage = await listen((request, response) => {
    requests.push({ url: `storage ${request.url ?? ""}`, headers: request.headers, body: "" });
    const release = state.releases.find((r) => `/${idOf(r.version)}` === request.url);
    response.writeHead(release?.file === undefined ? 404 : 200, {
      "content-type": "application/octet-stream",
    });
    response.end(release?.file ?? "{}");
  });
  const { server, origin } = await listen((request, response) => {
    const url = new URL(request.url ?? "/", "http://stand-in");
    requests.push({ url: request.url ?? "", headers: request.headers, body: "" });
    const send = (status: number, body: string, type = "application/json") => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    const path = url.pathname;
    if (path === "/repos/substrate-systems/evermatter/releases") {
      const perPage = Number(url.searchParams.get("per_page") ?? 30);
      const page = Number(url.searchParams.get("page") ?? 1);
      const newestFirst = [...state.releases].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt)
      );
      const body = newestFirst.slice((page - 1) * perPage, page * perPage).map((release) => {
        const id = idOf(release.version);
        return {
          id: 1,
          tag_name: `v${release.version}`,
          draft: release.publishedAt === null,
          prerelease: release.prerelease === true,
          created_at: release.createdAt,
          published_at: release.publishedAt,
          assets: [
            {
              name: "evermatter-cell-image.txt",
              url: `${origin}/repos/substrate-systems/evermatter/releases/assets/image-${id}`,
            },
            ...(release.file === undefined
              ? []
              : [
                  {
                    name: "release-notes.json",
                    url: `${origin}/repos/substrate-systems/evermatter/releases/assets/${id}`,
                  },
                ]),
          ],
        };
      });
      return send(200, JSON.stringify(body));
    }
    const assetMatch = /^\/repos\/substrate-systems\/evermatter\/releases\/assets\/(.+)$/.exec(
      path
    );
    if (assetMatch) {
      if (request.headers.accept !== "application/octet-stream") return send(415, "{}");
      response.writeHead(302, { location: `${storage.origin}/${assetMatch[1]}` });
      return response.end();
    }
    return send(404, "{}");
  });
  return {
    origin,
    get releases() {
      return state.releases;
    },
    requests,
    assetDownloads: (version) =>
      requests.filter((entry) => entry.url === `storage /${idOf(version)}`).length,
    close: async () => {
      await closeServer(server);
      await closeServer(storage.server);
    },
  };
}

export type ModelAnswer =
  /** `model` is the model the API reports on the answer; it defaults to the model the request named. */
  { picks: Array<{ version: string; position: number }>; model?: string } | { status: number };

export type ModelStandIn = {
  origin: string;
  /** Answers are served in order; the queue must hold one per call the test expects. */
  answers: ModelAnswer[];
  requests: Array<RequestLog & { json: Record<string, unknown> }>;
  close(): Promise<void>;
};

/** `POST /v1/messages` as the API answers a structured-output request, or with an error status. */
export async function startModel(): Promise<ModelStandIn> {
  const answers: ModelAnswer[] = [];
  const requests: ModelStandIn["requests"] = [];
  const { server, origin } = await listen(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({
      url: request.url ?? "",
      headers: request.headers,
      body,
      json: JSON.parse(body || "{}"),
    });
    const answer = answers.shift();
    if (request.method !== "POST" || request.url !== "/v1/messages" || !answer) {
      response.writeHead(500, { "content-type": "application/json" });
      return response.end(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "unscripted" } })
      );
    }
    if ("status" in answer) {
      response.writeHead(answer.status, { "content-type": "application/json" });
      return response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: answer.status === 529 ? "overloaded_error" : "api_error",
            message: "try again",
          },
        })
      );
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "msg_01StandIn",
        type: "message",
        role: "assistant",
        model: answer.model ?? requests.at(-1)?.json.model ?? "unknown",
        content: [{ type: "text", text: JSON.stringify({ picks: answer.picks }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 60 },
      })
    );
  });
  return { origin, answers, requests, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** One message as `sendTransactionalEmail` posts it to Brevo's `POST /v3/smtp/email`. */
export type BrevoMessage = {
  sender: { email: string; name: string };
  to: Array<{ email: string }>;
  subject: string;
  htmlContent: string;
  textContent: string;
  /** Custom headers, in Brevo's `headers` object; absent when the sender passed none. */
  headers?: Record<string, string>;
};

export type BrevoStandIn = {
  origin: string;
  /** Every accepted message, in the order it arrived. */
  sent: BrevoMessage[];
  close(): Promise<void>;
};

/**
 * Brevo's transactional send endpoint as it answers: the key in the `api-key` header, one JSON
 * message per `POST /v3/smtp/email`, and `201` with a `messageId`. It keeps what the sender posted,
 * so a test reads the request that left the code, not a copy of what the code meant to send.
 */
export async function startBrevo(apiKey: string): Promise<BrevoStandIn> {
  const sent: BrevoMessage[] = [];
  const { server, origin } = await listen(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method !== "POST" || request.url !== "/v3/smtp/email") {
      return reply(404, { code: "not_found", message: "Not found" });
    }
    if (request.headers["api-key"] !== apiKey) {
      return reply(401, { code: "unauthorized", message: "Key not found" });
    }
    sent.push(JSON.parse(body) as BrevoMessage);
    return reply(201, { messageId: `<${sent.length}.stand-in@smtp-relay.invalid>` });
  });
  return { origin, sent, close: () => closeServer(server) };
}
