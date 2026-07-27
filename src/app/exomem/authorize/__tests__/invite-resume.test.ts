import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseInvitationUrl, redeemInvitationUrl } from "../invite-resume";

const ORIGIN = "https://hosted.example.test";
const TOKEN = Buffer.alloc(32, 0x61).toString("base64url");
const INVITATION = `${ORIGIN}/exomem/invite#${TOKEN}`;

describe("OAuth invitation resume", () => {
  it("accepts only a same-origin invite URL with one base64url fragment token", () => {
    assert.equal(parseInvitationUrl(INVITATION, ORIGIN), TOKEN);
    for (const candidate of [
      `https://attacker.example/exomem/invite#${TOKEN}`,
      `${ORIGIN}/exomem/invite/#${TOKEN}`,
      `${ORIGIN}/exomem/invite?token=${TOKEN}`,
      `https://user:password@hosted.example.test/exomem/invite#${TOKEN}`,
      `${ORIGIN}/exomem/invite#`,
      `${ORIGIN}/exomem/invite#${TOKEN}%2Fmore`,
      `${ORIGIN}/exomem/invite#not-a-token`,
    ]) {
      assert.equal(parseInvitationUrl(candidate, ORIGIN), null, candidate);
    }
  });

  it("clears the pasted invitation before sending only its token to redeem and replacing", async () => {
    const calls: string[] = [];
    let redeemedPath = "";
    let redeemedBody: Record<string, unknown> | null = null;
    let destination = "";
    const result = await redeemInvitationUrl(
      { invitationUrl: INVITATION, origin: ORIGIN },
      {
        clear: () => calls.push("clear"),
        post: async (path, body) => {
          calls.push("redeem");
          redeemedPath = path;
          redeemedBody = body;
          return { destination: "https://client.example.test/oauth/callback?code=opaque" };
        },
        replace: (next) => {
          calls.push("replace");
          destination = next;
        },
      }
    );

    assert.equal(result, "redeemed");
    assert.deepEqual(calls, ["clear", "redeem", "replace"]);
    assert.equal(redeemedPath, "/api/exomem/access/redeem");
    assert.deepEqual(redeemedBody, { token: TOKEN });
    assert.equal(destination, "https://client.example.test/oauth/callback?code=opaque");
  });
});
