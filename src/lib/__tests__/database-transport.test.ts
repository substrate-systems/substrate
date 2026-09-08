import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "pg";
import { verifiedPostgresConfig } from "../database-transport";

const remote =
  "postgresql://fixture:synthetic-password@ep-fixture.eu-central-1.aws.neon.tech/fixture";

describe("verified PostgreSQL configuration", () => {
  it("pins omitted and explicit ports against pg's ambient endpoint defaults", () => {
    const previous = process.env.PGPORT;
    process.env.PGPORT = "6543";
    try {
      for (const [url, expected] of [
        [remote, 5432],
        [remote.replace(".tech/", ".tech:5434/"), 5434],
      ] as const) {
        const config = verifiedPostgresConfig(url, {});
        assert.equal(config.port, expected);
        const client = new Client(config);
        // Exercise the installed driver's resolution, not only our options.
        assert.equal(
          (client as unknown as { connectionParameters: { port: number } }).connectionParameters
            .port,
          expected
        );
      }
      assert.throws(
        () => verifiedPostgresConfig(remote.replace(".tech/", ".tech:0/"), {}),
        /DATABASE_TRANSPORT/
      );
    } finally {
      if (previous === undefined) delete process.env.PGPORT;
      else process.env.PGPORT = previous;
    }
  });

  it("refuses the plaintext exception without an explicit nonproduction environment", () => {
    for (const NODE_ENV of [undefined, "", "prod", "unknown"]) {
      assert.throws(
        () =>
          verifiedPostgresConfig("postgresql://fixture@127.0.0.1/fixture?sslmode=disable", {
            NODE_ENV,
            DATABASE_ALLOW_INSECURE_LOOPBACK: "true",
          }),
        /DATABASE_TRANSPORT/
      );
    }
  });

  it("requires certificate and exact peer verification for production Neon URI forms", () => {
    for (const suffix of ["", "?sslmode=require", "?sslmode=verify-full&channel_binding=require"]) {
      const config = verifiedPostgresConfig(remote + suffix, {});
      assert.equal(config.host, "ep-fixture.eu-central-1.aws.neon.tech");
      assert.equal(config.connectionString, undefined);
      assert.equal(typeof config.ssl, "object");
      if (!config.ssl || typeof config.ssl !== "object") throw new Error("TLS missing");
      assert.equal(config.ssl.rejectUnauthorized, true);
      assert.equal(typeof config.ssl.checkServerIdentity, "function");
      assert.equal(config.ssl.minVersion, "TLSv1.2");
    }
  });

  it("rejects plaintext, verification bypasses, duplicate and endpoint override options", () => {
    for (const query of [
      "sslmode=disable",
      "ssl=0",
      "ssl=false",
      "sslmode=no-verify",
      "sslmode=verify-ca",
      "sslmode=prefer",
      "uselibpqcompat=true",
      "sslmode=require&sslmode=disable",
      "host=127.0.0.1",
      "host=/tmp/socket",
      "port=9999",
      "connectionString=postgres://elsewhere/db",
      "sslmode=require&ssl=0",
      "sslnegotiation=unknown",
    ]) {
      assert.throws(() => verifiedPostgresConfig(`${remote}?${query}`, {}), /DATABASE_TRANSPORT/);
    }
  });

  it("refuses global TLS bypass and malformed configurations without exposing credentials", () => {
    assert.throws(
      () => verifiedPostgresConfig(remote, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
      /DATABASE_TRANSPORT/
    );
    for (const url of [
      "not-a-url-secret",
      "https://fixture:synthetic-password@example.test/db",
      "postgresql:///fixture",
      `${remote}#secret`,
      `${remote}?sslrootcert=/missing/synthetic-secret`,
    ]) {
      assert.throws(
        () => verifiedPostgresConfig(url, {}),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /^DATABASE_TRANSPORT_/);
          assert.doesNotMatch(error.message, /synthetic|fixture|password|not-a-url|missing/);
          return true;
        }
      );
    }
  });

  it("requires explicit development permission for literal loopback plaintext", () => {
    const dev = { NODE_ENV: "development", DATABASE_ALLOW_INSECURE_LOOPBACK: "true" };
    for (const host of ["127.0.0.1", "[::1]"]) {
      const uri = `postgresql://fixture:synthetic-password@${host}:5432/fixture?sslmode=disable`;
      assert.equal(verifiedPostgresConfig(uri, dev).ssl, false);
      assert.throws(() => verifiedPostgresConfig(uri, {}), /DATABASE_TRANSPORT/);
      assert.throws(
        () => verifiedPostgresConfig(uri, { ...dev, NODE_ENV: "production" }),
        /DATABASE_TRANSPORT/
      );
    }
    for (const host of ["localhost", "127.0.0.1.example.test", "192.0.2.10"]) {
      assert.throws(
        () => verifiedPostgresConfig(`postgresql://fixture@${host}/fixture?sslmode=disable`, dev),
        /DATABASE_TRANSPORT/
      );
    }
  });

  it("keeps direct TLS negotiation and query identity options without an environment downgrade", () => {
    const config = verifiedPostgresConfig(
      `${remote}?sslmode=require&sslnegotiation=direct&application_name=fixture&channel_binding=require`,
      { PGSSLMODE: "disable", PGHOST: "127.0.0.1" }
    );
    assert.equal(config.sslnegotiation, "direct");
    assert.equal(config.application_name, "fixture");
    assert.equal(config.enableChannelBinding, true);
    assert.equal(config.host, "ep-fixture.eu-central-1.aws.neon.tech");
    assert.ok(config.ssl);
  });
});
