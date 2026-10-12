// A stand-in for Brevo's transactional email API, for Home's end-to-end tests. The web
// server sends to it exactly as it sends to Brevo (BREVO_API_BASE_URL points here). It
// keeps each accepted email, so a test can open the link inside, and it refuses the
// recipients a test names, as an outage would.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type SentEmail = { to: string; subject: string; textContent: string };

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export function startFakeBrevo(options: {
  port: number;
  apiKey: string;
}): Promise<{ close: () => Promise<void> }> {
  const sent: SentEmail[] = [];
  const refused = new Set<string>();

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://brevo.invalid");
    // Brevo's send endpoint: the key in the api-key header, one JSON message per call.
    if (request.method === "POST" && url.pathname === "/v3/smtp/email") {
      if (request.headers["api-key"] !== options.apiKey) {
        return json(response, 401, { code: "unauthorized", message: "Key not found" });
      }
      const message = JSON.parse(await body(request));
      const to = String(message.to?.[0]?.email ?? "");
      if (refused.has(to)) {
        return json(response, 502, { code: "service_unavailable", message: "Try later" });
      }
      sent.push({ to, subject: message.subject, textContent: message.textContent });
      return json(response, 201, { messageId: `<${sent.length}@fake-brevo.invalid>` });
    }
    // Test control: GET /__mail?to=<address> lists what that address received;
    // POST /__mail/refuse {"to": <address>} makes every later send to it fail.
    if (request.method === "GET" && url.pathname === "/__mail") {
      return json(
        response,
        200,
        sent.filter((email) => email.to === url.searchParams.get("to"))
      );
    }
    if (request.method === "POST" && url.pathname === "/__mail/refuse") {
      refused.add(String(JSON.parse(await body(request)).to));
      return json(response, 200, {});
    }
    return json(response, 404, { code: "not_found" });
  });

  return new Promise((resolve) =>
    server.listen(options.port, "127.0.0.1", () =>
      resolve({ close: () => new Promise<void>((done) => server.close(() => done())) })
    )
  );
}
