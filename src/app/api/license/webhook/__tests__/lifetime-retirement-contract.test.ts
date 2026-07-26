import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const root = process.cwd();

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(root, relativePath), 'utf8');
}

describe('retired Endstate lifetime checkout contract', () => {
  it('has no lifetime checkout or lifetime license-minting path', async () => {
    const [paddle, buyButton, webhook] = await Promise.all([
      source('src/lib/paddle.ts'),
      source('src/app/endstate/BuyButton.tsx'),
      source('src/app/api/license/webhook/route.ts'),
    ]);

    for (const contents of [paddle, buyButton, webhook]) {
      assert.doesNotMatch(contents, /ENDSTATE_LIFETIME/);
      assert.doesNotMatch(contents, /openEndstateCheckout/);
    }

    assert.doesNotMatch(webhook, /createLicenseKey|insertLicense/);
    assert.match(webhook, /handleSupporterPurchase/);
    assert.match(webhook, /NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER/);
  });

  it('removes the unused lifetime activation surface', async () => {
    const retiredPaths = [
      'src/app/api/license/activate/route.ts',
      'src/app/api/license/deactivate/route.ts',
      'src/app/api/license/internal-debug/send-test-email/route.ts',
      'src/lib/email-templates/license-key.ts',
      'src/lib/license/crypto.ts',
      'src/lib/license/db.ts',
      'scripts/generate-keypair.ts',
      'scripts/init-db.sql',
      'scripts/test-license-api.sh',
      'scripts/test-license-crypto.mjs',
    ];

    for (const relativePath of retiredPaths) {
      await assert.rejects(stat(path.join(root, relativePath)), { code: 'ENOENT' });
    }
  });
});
