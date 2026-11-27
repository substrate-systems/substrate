import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { whatsNewDigestConfig } from "../config";
import type { MonthNote } from "../notes";
import { notesForRunningRelease } from "../owner-notes";
import { invitationShows } from "../setting";
import {
  signUnsubscribeToken,
  unsubscribeAddresses,
  UnsubscribeKeyError,
  unsubscribeKey,
  unsubscribeKeyConfigured,
  unsubscribeKeyStatus,
  unsubscribeVerifyKeys,
  verifyUnsubscribeToken,
} from "../unsubscribe";

const note = (version: string, position: number): MonthNote => ({
  version,
  position,
  title: null,
  text: `${version}#${position}`,
});

describe("which notes an owner's cell runs", () => {
  const selection = [note("1.10.0", 0), note("1.9.2", 0), note("1.9.0", 0), note("1.2.0", 0)];

  it("compares the three parts of a version as numbers, so 1.10.0 is newer than 1.9.2", () => {
    assert.deepEqual(
      notesForRunningRelease(selection, "v1.9.2")?.map((n) => n.version),
      ["1.9.2", "1.9.0", "1.2.0"]
    );
    assert.deepEqual(
      notesForRunningRelease(selection, "v1.10.0")?.map((n) => n.version),
      ["1.10.0", "1.9.2", "1.9.0", "1.2.0"]
    );
  });

  it("keeps the selection's order and gives none when fewer than 3 notes are left", () => {
    assert.equal(notesForRunningRelease(selection, "v1.9.0"), null);
    assert.equal(notesForRunningRelease(selection, "v0.9.0"), null);
  });

  it("gives none for a running release that is unknown or is not a release tag", () => {
    for (const unknown of [null, "", "1.10.0", "v1.10", "latest", "v1.10.0-rc1"]) {
      assert.equal(notesForRunningRelease(selection, unknown), null, String(unknown));
    }
  });
});

describe("the unsubscribe token", () => {
  const key = randomBytes(32);
  const tenantId = randomUUID();

  it("names its tenant when it is genuine", () => {
    assert.equal(verifyUnsubscribeToken(signUnsubscribeToken(tenantId, key), key), tenantId);
  });

  it("is refused when it is altered, signed by another key, or not a token at all", () => {
    const token = signUnsubscribeToken(tenantId, key);
    const [payload, mac] = token.split(".");
    const other = Buffer.from(
      JSON.stringify({ v: 1, purpose: "whats-new-digest-unsubscribe", tenant_id: randomUUID() })
    ).toString("base64url");
    for (const bad of [
      `${other}.${mac}`,
      `${payload}.${mac!.slice(0, -2)}`,
      signUnsubscribeToken(tenantId, randomBytes(32)),
      tenantId,
      "",
      "a.b.c",
      "x".repeat(600),
    ]) {
      assert.equal(verifyUnsubscribeToken(bad, key), null, bad.slice(0, 20));
    }
  });

  it("serves one purpose: a genuine MAC over claims for another purpose is refused", () => {
    const payload = Buffer.from(
      JSON.stringify({ v: 1, purpose: "something-else", tenant_id: tenantId })
    ).toString("base64url");
    const mac = createHmac("sha256", key)
      .update("exomem-whats-new-digest-unsubscribe:v1\0", "utf8")
      .update(payload, "utf8")
      .digest("base64url");
    assert.equal(verifyUnsubscribeToken(`${payload}.${mac}`, key), null);
  });

  it("verifies a link signed with the previous key during a rotation, and signs only with the current one", () => {
    const previous = randomBytes(32);
    const current = randomBytes(32);
    const oldLink = signUnsubscribeToken(tenantId, previous);
    assert.equal(verifyUnsubscribeToken(oldLink, [current, previous]), tenantId);
    assert.equal(
      verifyUnsubscribeToken(signUnsubscribeToken(tenantId, current), [current, previous]),
      tenantId
    );
    // Once the previous key is removed, the old links stop.
    assert.equal(verifyUnsubscribeToken(oldLink, [current]), null);
    assert.equal(
      verifyUnsubscribeToken(signUnsubscribeToken(tenantId, randomBytes(32)), [current, previous]),
      null
    );
  });

  it("reads the previous key from configuration, and ignores a malformed one without dropping the current key's links", () => {
    const keyText = () => randomBytes(32).toString("base64url");
    const [current, previous] = [keyText(), keyText()];
    const config = (env: Record<string, string>) => whatsNewDigestConfig(env);
    const withPrevious = (value: string) =>
      config({
        EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY: current,
        EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY_PREVIOUS: value,
      });
    assert.equal(
      unsubscribeVerifyKeys(config({ EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY: current })).length,
      1
    );
    assert.equal(unsubscribeVerifyKeys(withPrevious(previous)).length, 2);

    const malformed = withPrevious("short");
    const keys = unsubscribeVerifyKeys(malformed);
    assert.equal(keys.length, 1, "the malformed key is not added to the set that verifies");
    assert.equal(
      verifyUnsubscribeToken(
        signUnsubscribeToken(tenantId, Buffer.from(current, "base64url")),
        keys
      ),
      tenantId
    );
    // A malformed rotation is told apart from a good one and stops the queue; a wrong current key does too.
    assert.deepEqual(unsubscribeKeyStatus(malformed), { current: "ok", previous: "malformed" });
    assert.equal(unsubscribeKeyConfigured(malformed), false);
    assert.equal(unsubscribeKeyConfigured(withPrevious(previous)), true);
    assert.equal(
      unsubscribeKeyConfigured(config({ EXOMEM_WHATS_NEW_UNSUBSCRIBE_KEY: current })),
      true
    );
    assert.equal(unsubscribeKeyConfigured(config({})), false);
    assert.throws(() => unsubscribeVerifyKeys(config({})), UnsubscribeKeyError);
  });

  it("puts the token in the query for the POST address and in the fragment for the page link", () => {
    const { post, page } = unsubscribeAddresses("https://substratesystems.io", tenantId, key);
    const token = signUnsubscribeToken(tenantId, key);
    assert.equal(new URL(post).searchParams.get("token"), token);
    assert.equal(new URL(page).hash, `#${token}`);
    assert.equal(new URL(page).search, "");
  });

  it("needs a key of 32 bytes as base64url, and says so when it is unset or malformed", () => {
    assert.equal(unsubscribeKey(randomBytes(32).toString("base64url")).length, 32);
    for (const bad of [
      null,
      "",
      "short",
      randomBytes(31).toString("base64url"),
      "not base64url!",
    ]) {
      assert.throws(() => unsubscribeKey(bad), UnsubscribeKeyError);
    }
  });
});

describe("Home's invitation", () => {
  it("shows only while it is open and the setting is off", () => {
    assert.equal(invitationShows("open", false), true);
    assert.equal(invitationShows("open", true), false);
    for (const closed of ["none", "dismissed", "accepted"] as const) {
      assert.equal(invitationShows(closed, false), false, closed);
    }
  });
});
