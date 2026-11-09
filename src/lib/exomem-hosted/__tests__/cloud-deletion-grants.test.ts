import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { CLOUD_CELL_ID_PATTERN } from "../cloud-config";
import {
  CELL_DELETION_GRACE_SECONDS,
  signCloudDeletionGrant,
} from "../cloud-deletion-grants";

const KEY_VARIABLE = "EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY";
const CELL_ID = "a2b3c4d5e6f7g2h3";

// The fixture every grant verifier accepts or refuses alike
// (automate-cell-storage-deletion D1): the rules below are read from it, not
// restated, so a contract change in either repository turns this suite red.
const fixture = JSON.parse(
  readFileSync(resolve(process.cwd(), "contracts/cell-deletion-grants-v1.json"), "utf8")
) as {
  public_keys: string[];
  grants: Array<{
    case: string;
    token: unknown;
    accepted: { cell_id: string; iat: number; purge_after: number } | null;
  }>;
};
const accepted = fixture.grants.filter((grant) => grant.accepted !== null);

function grantEnv() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    env: { [KEY_VARIABLE]: privateKey.export({ format: "pem", type: "pkcs8" }).toString() },
    publicKey,
  };
}

describe("deletion grant signer", () => {
  afterEach(() => mock.restoreAll());

  it("signs a grant every executor accepts: the fixture's header, claim set, audience, grace and cell shape", async () => {
    const { env, publicKey } = grantEnv();
    const token = await signCloudDeletionGrant(CELL_ID, { env, now: 1_790_000_000 });
    assert.equal(typeof token, "string", "a deletion grant is a compact JWT string");

    // The header the executors pin (typ JWT, alg EdDSA) is whatever the
    // fixture's accepted tokens carry.
    const acceptedHeaders = accepted.map((grant) => decodeProtectedHeader(grant.token as string));
    for (const header of acceptedHeaders) {
      assert.deepEqual(decodeProtectedHeader(token as string), header);
    }

    // Exactly the claims the accepted tokens carry: an added `exp` or a
    // missing `jti` fails this set, as the verifiers refuse those cases.
    const claims = decodeJwt(token as string) as Record<string, unknown>;
    for (const grant of accepted) {
      assert.deepEqual(
        Object.keys(claims).sort(),
        Object.keys(decodeJwt(grant.token as string)).sort()
      );
    }
    assert.equal(
      claims.aud,
      decodeJwt(accepted[0]!.token as string).aud,
      "the audience is the fixture's, not another object's"
    );

    assert.ok(Number.isInteger(claims.iat) && Number.isInteger(claims.purge_after));
    // At least the smallest grace any verifier accepts; equal to the 7-day grace.
    const smallestAcceptedGrace = Math.min(
      ...accepted.map((grant) => grant.accepted!.purge_after - grant.accepted!.iat)
    );
    const grace = (claims.purge_after as number) - (claims.iat as number);
    assert.ok(grace >= smallestAcceptedGrace, `grace ${grace}`);
    assert.equal(grace, CELL_DELETION_GRACE_SECONDS);

    // The cell shape the executors check before they turn it into a path segment.
    assert.equal(claims.cell_id, CELL_ID);
    assert.match(String(claims.cell_id), CLOUD_CELL_ID_PATTERN);
    assert.match(accepted[0]!.accepted!.cell_id, CLOUD_CELL_ID_PATTERN);
    // The cell-shape refusal is the refused case whose payload matches an
    // accepted one in every claim but cell_id (jti differs legitimately).
    const acceptedPayloads = accepted.map((grant) => decodeJwt(grant.token as string));
    const wrongShape = fixture.grants.filter((grant) => {
      if (grant.accepted !== null || typeof grant.token !== "string") return false;
      let claims;
      try {
        claims = decodeJwt(grant.token);
      } catch {
        return false;
      }
      return acceptedPayloads.some(
        (other) =>
          claims.cell_id !== other.cell_id &&
          ["aud", "iat", "purge_after"].every((key) => claims[key] === other[key])
      );
    });
    assert.equal(wrongShape.length, 1, "exactly one refused case isolates the cell shape");
    assert.doesNotMatch(
      String(decodeJwt(wrongShape[0]!.token as string).cell_id),
      CLOUD_CELL_ID_PATTERN
    );

    // A verifier that pins the matching public key, EdDSA and the audience passes.
    await jwtVerify(token as string, publicKey, {
      algorithms: ["EdDSA"],
      audience: decodeJwt(accepted[0]!.token as string).aud as string,
    });
  });

  it("signs nothing, and does not fail, while no deletion grant key is configured", async () => {
    assert.equal(await signCloudDeletionGrant(CELL_ID, { env: {} }), null);
    assert.equal(await signCloudDeletionGrant(CELL_ID, { env: { [KEY_VARIABLE]: "  " } }), null);
    // The operation grant key never stands in: turning purges on is its own decision.
    const { env } = grantEnv();
    assert.equal(
      await signCloudDeletionGrant(CELL_ID, {
        env: { EXOMEM_CLOUD_GRANT_SIGNING_KEY: env[KEY_VARIABLE] },
      }),
      null
    );
  });

  it("refuses to sign for a cell ID outside the Cloud cell shape", async () => {
    const { env } = grantEnv();
    await assert.rejects(signCloudDeletionGrant("short", { env }));
    await assert.rejects(signCloudDeletionGrant("../a2b3c4d5e6f7g", { env }));
  });
});
