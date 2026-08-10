/**
 * Imports the first pre-tier €89 Supporter purchase as Patron without
 * touching Paddle, Brevo, or the customer. Run only after comparing the three
 * supplied values with the original Paddle receipt and webhook archive.
 */
import { recordLegacySupporterContribution } from "@/lib/hosted-backup/db";

function value(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const transactionId = value("transaction-id");
  const eventId = value("event-id");
  const occurredAtText = value("occurred-at");
  const email = value("email");
  const apply = process.argv.includes("--apply");
  const confirmedTransactionId = value("confirm-transaction-id");
  const occurredAt = occurredAtText ? new Date(occurredAtText) : null;

  if (
    !transactionId ||
    !eventId ||
    !occurredAtText ||
    !occurredAt ||
    Number.isNaN(occurredAt.getTime())
  ) {
    throw new Error(
      "usage: --transaction-id=… --event-id=… --occurred-at=ISO-8601 [--email=…] [--apply --confirm-transaction-id=…]"
    );
  }
  if (!apply) {
    console.log(
      `[legacy-patron] dry-run: would import ${transactionId} as Patron at ${occurredAt.toISOString()}; no database or provider action taken`
    );
    return;
  }
  if (confirmedTransactionId !== transactionId) {
    throw new Error("--apply requires --confirm-transaction-id to exactly match --transaction-id");
  }

  const inserted = await recordLegacySupporterContribution({
    transactionId,
    eventId,
    occurredAt,
    email,
  });
  console.log(
    `[legacy-patron] ${inserted ? "imported" : "already present"}: ${transactionId}; historical email obligations remain fulfilled; recognition still requires explicit consent`
  );
}

main().catch((error) => {
  console.error("[legacy-patron] failed:", error);
  process.exitCode = 1;
});
