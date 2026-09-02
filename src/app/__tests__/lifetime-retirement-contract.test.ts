import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("retired Endstate paid-checkout contract", () => {
  it("has no lifetime checkout or lifetime license-minting path", async () => {
    const [paddle, buyButton, supportTiers] = await Promise.all([
      source("src/lib/paddle.ts"),
      source("src/app/endstate/BuyButton.tsx"),
      source("src/lib/support-tiers.ts"),
    ]);

    for (const contents of [paddle, buyButton, supportTiers]) {
      assert.doesNotMatch(contents, /ENDSTATE_LIFETIME/);
      assert.doesNotMatch(contents, /openEndstateCheckout/);
    }
  });

  it("has no Paddle path left on the voluntary-support surface", async () => {
    const [paddle, supportTiers] = await Promise.all([
      source("src/lib/paddle.ts"),
      source("src/lib/support-tiers.ts"),
    ]);

    // Voluntary support moved to GitHub Sponsors: the tier definitions carry no
    // Paddle price identifier, no environment lookup, and no checkout.
    assert.doesNotMatch(supportTiers, /[Pp]addle/);
    assert.doesNotMatch(supportTiers, /process\.env/);
    assert.match(supportTiers, /github\.com\/sponsors\/substrate-systems/);

    // Paddle itself stays for Endstate Cloud, but with no support checkout.
    assert.doesNotMatch(paddle, /openSupportCheckout/);
    assert.match(paddle, /openHostedBackupCheckout/);
  });

  it("removes the unused lifetime activation and supporter-purchase surface", async () => {
    const retiredPaths = [
      "src/app/api/license/activate/route.ts",
      "src/app/api/license/deactivate/route.ts",
      "src/app/api/license/internal-debug/send-test-email/route.ts",
      "src/app/api/license/webhook/route.ts",
      "src/lib/email-templates/license-key.ts",
      "src/lib/email-templates/supporter.ts",
      "src/lib/license/crypto.ts",
      "src/lib/license/db.ts",
      "scripts/generate-keypair.ts",
      "scripts/init-db.sql",
      "scripts/test-license-api.sh",
      "scripts/test-license-crypto.mjs",
    ];

    for (const relativePath of retiredPaths) {
      await assert.rejects(stat(path.join(root, relativePath)), { code: "ENOENT" });
    }
  });
});
