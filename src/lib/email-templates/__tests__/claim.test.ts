/**
 * Regression: claim email + page must display the *same* value that gets
 * copied / pasted into the GUI. Issue #13 — the email previously rendered a
 * 16-char dashed projection of the 43-char auth token (lossy, can't pass
 * the GUI's 43-char regex). Display now equals the full token.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderClaimEmail, renderResendClaimEmail } from '../claim';

const SAMPLE_TOKEN = 'asA5wXo0POmrwRAoE8x_keCT9PU7c9tK_ecVSg5bOlM';

describe('renderClaimEmail (issue #13)', () => {
  it('renders the full 43-char token in both HTML and plaintext bodies', () => {
    const { htmlContent, textContent } = renderClaimEmail({
      email: 'buyer@example.com',
      token: SAMPLE_TOKEN,
    });
    assert.ok(
      htmlContent.includes(SAMPLE_TOKEN),
      'HTML body must contain the full token (GUI requires the 43-char value)',
    );
    assert.ok(
      textContent.includes(SAMPLE_TOKEN),
      'Plaintext body must contain the full token',
    );
  });

  it('does NOT render the dashed 16-char projection', () => {
    const { htmlContent, textContent } = renderClaimEmail({
      email: 'buyer@example.com',
      token: SAMPLE_TOKEN,
    });
    // The old lossy projection of SAMPLE_TOKEN.
    const lossyProjection = 'ASA5-WXO0-POMR-WRAO';
    assert.ok(
      !htmlContent.includes(lossyProjection),
      'HTML body must not contain the lossy dashed projection',
    );
    assert.ok(
      !textContent.includes(lossyProjection),
      'Plaintext body must not contain the lossy dashed projection',
    );
  });
});

describe('renderResendClaimEmail (issue #13)', () => {
  it('renders the full 43-char token in both HTML and plaintext bodies', () => {
    const { htmlContent, textContent } = renderResendClaimEmail({
      email: 'buyer@example.com',
      token: SAMPLE_TOKEN,
    });
    assert.ok(htmlContent.includes(SAMPLE_TOKEN));
    assert.ok(textContent.includes(SAMPLE_TOKEN));
  });
});
