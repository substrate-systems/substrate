import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExomemHostedError } from "../errors";
import { inspectInvitation, issueOperatorInvite } from "../invites";

const TOKEN = Buffer.alloc(32, 0x61).toString("base64url");

function friendInvitation() {
  return {
    kind: "friend" as const,
    email: "invitee@example.test",
    expiresAt: new Date("2026-11-11T09:00:00Z"),
    inviterName: "Alex Example",
    note: null,
    ownerUserId: null,
  };
}

describe("Exomem invitations", () => {
  it("shows the price as unknown with its reason, never a number, when Paddle's preview fails", async () => {
    const inspection = await inspectInvitation(
      { token: TOKEN, country: "DE", customerIp: "203.0.113.7", sessionUserId: null },
      {
        findUsable: async () => friendInvitation(),
        previewPrices: async () => {
          throw new Error("paddle down");
        },
      }
    );
    assert.deepEqual(inspection?.price, { value: null, reason: "price_unavailable" });
  });

  it("refuses an inviter name that could pose as an address or break the sender line, before anything is stored", async () => {
    for (const inviterName of ["alex@bank.example", "Alex <alex@x.example>", "Alex\r\nBcc: x"]) {
      let created = 0;
      await assert.rejects(
        issueOperatorInvite(
          {
            email: "invitee@example.test",
            kind: "covered",
            inviterName,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            operatorPrincipalDigest: Buffer.alloc(32, 7),
          },
          {
            createInvite: async () => {
              created += 1;
              return { inviteId: "invite-1" };
            },
          }
        ),
        (error) => error instanceof ExomemHostedError && error.code === "INVITATION_FIELDS_INVALID"
      );
      assert.equal(created, 0, inviterName);
    }
  });
});
