import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import type { ExomemSql } from "../db";
import { ExomemHostedError } from "../errors";
import { inspectInvitation, issueOperatorInvite } from "../invites";

process.env.EXOMEM_CONTROL_PLANE_KEY ??= randomBytes(32).toString("base64url");
const TOKEN = Buffer.alloc(32, 0x61).toString("base64url");

function friendInvitation() {
  return {
    id: "invite-1",
    kind: "friend" as const,
    email: "invitee@example.test",
    expiresAt: new Date("2026-11-11T09:00:00Z"),
    inviterName: "Alex Example",
    note: null,
    owner: null,
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
    assert.ok(inspection?.status === "invite");
    assert.deepEqual(inspection.price, { value: null, reason: "price_unavailable" });
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

  // The email row is invisible to the sender until the invite's transaction
  // commits, so a dispatch inside it would find nothing and wait for the job.
  it("sends the invitation email once the invite has committed, not inside its transaction", async () => {
    const events: string[] = [];
    const queueRow: ExomemSql = async () => ({ rows: [{ id: "email-1" }], rowCount: 1 });
    await issueOperatorInvite(
      {
        email: "invitee@example.test",
        kind: "covered",
        inviterName: "Alex Example",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        operatorPrincipalDigest: Buffer.alloc(32, 7),
      },
      {
        createInvite: async (input) => {
          await input.afterCreate?.(queueRow, { inviteId: "invite-1", createdAt: new Date() });
          events.push("committed");
          return { inviteId: "invite-1" };
        },
        dispatchQueuedEmails: async (ids) => {
          events.push(`dispatched ${ids.join(",")}`);
        },
      }
    );
    assert.deepEqual(events, ["committed", "dispatched email-1"]);
  });
});
