/**
 * Verifies the single env-var Paddle sandbox/production switch.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { paddleApiBaseUrl } from '../paddle-client';

afterEach(() => {
  delete process.env.PADDLE_ENVIRONMENT;
});

describe('paddleApiBaseUrl', () => {
  it('returns the sandbox base URL when PADDLE_ENVIRONMENT is unset', () => {
    delete process.env.PADDLE_ENVIRONMENT;
    assert.equal(paddleApiBaseUrl(), 'https://sandbox-api.paddle.com');
  });

  it('returns the sandbox base URL when PADDLE_ENVIRONMENT is "sandbox"', () => {
    process.env.PADDLE_ENVIRONMENT = 'sandbox';
    assert.equal(paddleApiBaseUrl(), 'https://sandbox-api.paddle.com');
  });

  it('returns the production base URL when PADDLE_ENVIRONMENT is "production"', () => {
    process.env.PADDLE_ENVIRONMENT = 'production';
    assert.equal(paddleApiBaseUrl(), 'https://api.paddle.com');
  });

  it('treats unrecognized values as sandbox (default-safe)', () => {
    process.env.PADDLE_ENVIRONMENT = 'staging';
    assert.equal(paddleApiBaseUrl(), 'https://sandbox-api.paddle.com');
  });
});
