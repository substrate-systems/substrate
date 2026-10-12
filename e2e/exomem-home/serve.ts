// Starts what Home's end-to-end tests run against: the gateway-and-cell stand-in over
// TLS and the Brevo stand-in, then the production Next server pointed at them and at
// the test database.
// Playwright's webServer runs this; it also serves a manual look in a browser:
//
//   DATABASE_URL=postgresql://… npx tsx e2e/exomem-home/serve.ts
//
// The certificate is made fresh for 127.0.0.1 and trusted only by the Next process
// this script starts.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeBrevo } from "./fake-brevo";
import { startFakeCell } from "./fake-cell";
import { homeE2eEnvironment } from "./environment";

async function main() {
  const environment = homeE2eEnvironment();
  // The gateway stand-in reads the same configuration as the gateway it replaces.
  Object.assign(process.env, environment.serverEnv);
  // One fixed folder, made fresh each run: a run that is killed leaves this one folder,
  // and the next run replaces it, so killed runs never pile up.
  const certificates = join(tmpdir(), "exomem-home-e2e");
  rmSync(certificates, { recursive: true, force: true });
  mkdirSync(certificates, { mode: 0o700 });
  const keyPath = join(certificates, "key.pem");
  const certPath = join(certificates, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" }
  );

  const cell = await startFakeCell({
    port: environment.cellPort,
    controlPort: environment.controlPort,
    key: readFileSync(keyPath, "utf8"),
    cert: readFileSync(certPath, "utf8"),
    resource: environment.mcpUrl,
  });
  const mail = await startFakeBrevo({ port: environment.mailPort, apiKey: environment.mailApiKey });

  const next = spawn("npx", ["next", "start", "--port", String(environment.port)], {
    stdio: "inherit",
    env: {
      ...process.env,
      ...environment.serverEnv,
      NODE_EXTRA_CA_CERTS: certPath,
    },
  });

  const stop = async () => {
    next.kill("SIGTERM");
    await Promise.all([cell.close(), mail.close()]);
    rmSync(certificates, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void stop().then(() => process.exit(0)));
  }
  next.on("exit", (code) => void stop().then(() => process.exit(code ?? 0)));
}

void main();
