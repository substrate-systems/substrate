import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openClaimInEndstate } from './ClaimClient';

const TOKEN = 'claim token/with?reserved&characters';
const EXPECTED_URL = 'endstate://claim?token=claim%20token%2Fwith%3Freserved%26characters';

describe('openClaimInEndstate', () => {
  it('copies the raw token before launching the encoded deep link', async () => {
    const events: string[] = [];

    await openClaimInEndstate(
      TOKEN,
      async (value) => {
        events.push(`copy:${value}`);
      },
      (url) => {
        events.push(`launch:${url}`);
      },
    );

    assert.deepEqual(events, [`copy:${TOKEN}`, `launch:${EXPECTED_URL}`]);
  });

  it('launches before a pending clipboard write settles', async () => {
    const events: string[] = [];
    let settleCopy!: () => void;
    const pendingCopy = new Promise<void>((resolve) => {
      settleCopy = resolve;
    });

    openClaimInEndstate(
      TOKEN,
      (value) => {
        events.push(`copy:${value}`);
        return pendingCopy;
      },
      (url) => {
        events.push(`launch:${url}`);
      },
    );

    assert.deepEqual(events, [`copy:${TOKEN}`, `launch:${EXPECTED_URL}`]);
    settleCopy();
    await pendingCopy;
  });

  it('still launches when clipboard access fails', async () => {
    const launched: string[] = [];

    openClaimInEndstate(
      TOKEN,
      async () => {
        throw new Error('clipboard denied');
      },
      (url) => {
        launched.push(url);
      },
    );

    await Promise.resolve();

    assert.deepEqual(launched, [EXPECTED_URL]);
  });
});
