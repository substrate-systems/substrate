import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSecureContext, TLSSocket } from "node:tls";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { verifiedPostgresConfig } from "../database-transport";

const run = promisify(execFile);
let root: string;
function openssl(...args: string[]) {
  execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
}
function packet(type: string, payload: Buffer) {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}
function auth(code: number) {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(code);
  return packet("R", payload);
}

/** Minimal wire peer records whether TLS admitted any startup/credential bytes. */
async function peer(certificate = "valid", refuseTls = false) {
  const startup: Buffer[] = [];
  const passwords: Buffer[] = [];
  const queries: string[] = [];
  const sockets = new Set<Socket>();
  const context = createSecureContext({
    cert: readFileSync(join(root, `${certificate}.crt`)),
    key: readFileSync(join(root, "leaf.key")),
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (hello) => {
      assert.equal(hello.toString("hex"), "0000000804d2162f");
      if (refuseTls) {
        socket.end("N");
        return;
      }
      socket.write("S");
      const secure = new TLSSocket(socket, { isServer: true, secureContext: context });
      secure.on("error", () => {});
      let pending: Buffer = Buffer.alloc(0);
      let initial = true;
      secure.on("data", (data: Buffer) => {
        pending = Buffer.concat([pending, data]);
        while (pending.length >= (initial ? 4 : 5)) {
          const size = initial ? pending.readInt32BE(0) : pending.readInt32BE(1) + 1;
          if (pending.length < size) return;
          const message = pending.subarray(0, size);
          pending = pending.subarray(size);
          if (initial) {
            startup.push(message);
            initial = false;
            secure.write(auth(3));
          } else if (message[0] === 112) {
            passwords.push(message.subarray(5));
            secure.write(Buffer.concat([auth(0), packet("Z", Buffer.from("I"))]));
          } else if (message[0] === 81) {
            const query = message.subarray(5, -1).toString();
            queries.push(query);
            secure.write(
              Buffer.concat([packet("C", Buffer.from("SELECT 0\0")), packet("Z", Buffer.from("I"))])
            );
          } else if (message[0] === 88) secure.end();
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const uri = `postgresql://fixture:synthetic-password@127.0.0.1:${address.port}/fixture`;
  return {
    uri,
    startup,
    passwords,
    queries,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "substrate-database-tls-"));
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-subj",
    "/CN=Synthetic database CA",
    "-days",
    "2"
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=Synthetic database peer"
  );
  writeFileSync(
    join(root, "valid.ext"),
    "subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n"
  );
  writeFileSync(
    join(root, "wrong.ext"),
    "subjectAltName=DNS:wrong.example.test\nextendedKeyUsage=serverAuth\n"
  );
  for (const name of ["valid", "wrong", "expired"]) {
    openssl(
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.crt`,
      "-days",
      name === "expired" ? "-1" : "2",
      "-extfile",
      name === "wrong" ? "wrong.ext" : "valid.ext"
    );
  }
});
after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("real PostgreSQL TLS admission", () => {
  it("admits a trusted exact peer before sending credentials", async () => {
    const endpoint = await peer();
    const client = new Client(
      verifiedPostgresConfig(
        `${endpoint.uri}?sslmode=require&sslrootcert=${encodeURIComponent(join(root, "ca.crt"))}`,
        {}
      )
    );
    try {
      await client.connect();
      assert.equal(endpoint.startup.length, 1);
      assert.match(endpoint.startup[0].toString(), /fixture/);
      assert.equal(endpoint.passwords[0].toString(), "synthetic-password\0");
    } finally {
      await client.end();
      await endpoint.close();
    }
  });

  it("verifies a DNS peer using its certificate name", async () => {
    const endpoint = await peer();
    const uri = endpoint.uri.replace("127.0.0.1", "localhost");
    const client = new Client(
      verifiedPostgresConfig(`${uri}?sslrootcert=${encodeURIComponent(join(root, "ca.crt"))}`, {})
    );
    try {
      await client.connect();
      assert.equal(endpoint.passwords.length, 1);
    } finally {
      await client.end();
      await endpoint.close();
    }
  });

  for (const failure of ["wrong", "expired", "untrusted", "plaintext"] as const) {
    it(`rejects ${failure} before startup or password transmission`, async () => {
      const endpoint = await peer(
        failure === "wrong" || failure === "expired" ? failure : "valid",
        failure === "plaintext"
      );
      const ca =
        failure === "untrusted" ? "" : `&sslrootcert=${encodeURIComponent(join(root, "ca.crt"))}`;
      const client = new Client({
        ...verifiedPostgresConfig(`${endpoint.uri}?sslmode=require${ca}`, {}),
        connectionTimeoutMillis: 2000,
      });
      try {
        await assert.rejects(
          client.connect(),
          failure === "wrong"
            ? /IP|Hostname|altname/i
            : failure === "expired"
              ? /expired/i
              : failure === "plaintext"
                ? /SSL connections/i
                : /certificate|issuer/i
        );
        assert.equal(endpoint.startup.length, 0);
        assert.equal(endpoint.passwords.length, 0);
      } finally {
        await client.end();
        await endpoint.close();
      }
    });
  }

  for (const operation of ["executeExomemTransaction", "withExomemTransaction"]) {
    it(`uses the verified transport through ${operation}`, async () => {
      const endpoint = await peer();
      try {
        // A child owns the production pool lifecycle; no application test seam.
        await run(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
          const m = await import('./src/lib/exomem-hosted/db.ts');
          const fn = m.${operation} ?? m.default?.${operation};
          await fn(async () => {});
          process.exit(0);
        `,
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              NODE_ENV: "production",
              DATABASE_URL: `${endpoint.uri}?sslmode=require&sslrootcert=${encodeURIComponent(join(root, "ca.crt"))}`,
            },
            timeout: 10000,
          }
        );
        assert.equal(endpoint.startup.length, 1);
        assert.equal(endpoint.passwords.length, 1);
        assert.match(endpoint.queries[0], /^BEGIN/);
        assert.equal(endpoint.queries.at(-1), "COMMIT");
      } finally {
        await endpoint.close();
      }
    });
  }
});
