import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
});
