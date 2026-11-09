import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  computeSignature,
  TOLERANCE_SECONDS,
  verifyWebhook,
  WebhookVerificationError,
  type WebhookRejection,
} from './verify.js';

// Secrets are generated per test run: no fixed secret-like strings in the repository.
const secret = randomBytes(32).toString('hex');
const previousSecret = randomBytes(32).toString('hex');

const NOW = Date.parse('2026-06-01T15:00:00Z');
const nowSeconds = NOW / 1000;
const body = Buffer.from(
  JSON.stringify({ id: 'evt_example_1', type: 'payment.succeeded', amount: 52500 }),
);

const header = (timestamp: number, ...secrets: string[]) =>
  [
    `t=${timestamp}`,
    ...secrets.map((s) => `v1=${computeSignature(s, timestamp, body).toString('hex')}`),
  ].join(',');

function rejection(run: () => unknown): WebhookRejection {
  try {
    run();
  } catch (error) {
    if (error instanceof WebhookVerificationError) return error.reason;
    throw error;
  }
  throw new Error('the webhook was accepted');
}

describe('verifyWebhook', () => {
  it('accepts a correctly signed, recent webhook and returns its payload', () => {
    const verified = verifyWebhook(body, header(nowSeconds, secret), [secret], NOW);
    expect(verified.payload).toMatchObject({ id: 'evt_example_1', amount: 52500 });
  });

  it('refuses a missing or malformed signature header', () => {
    expect(rejection(() => verifyWebhook(body, undefined, [secret], NOW))).toBe(
      'missing_signature',
    );
    expect(rejection(() => verifyWebhook(body, '', [secret], NOW))).toBe('missing_signature');
    for (const bad of ['garbage', `t=${nowSeconds}`, 'v1=abcd', `t=soon,v1=${'0'.repeat(64)}`]) {
      expect(rejection(() => verifyWebhook(body, bad, [secret], NOW))).toBe('malformed_signature');
    }
  });

  it('refuses a body changed after signing, even by one byte', () => {
    const tampered = Buffer.from(body.toString().replace('52500', '52501'));
    expect(
      rejection(() => verifyWebhook(tampered, header(nowSeconds, secret), [secret], NOW)),
    ).toBe('bad_signature');
  });

  it('refuses re-serialized JSON: only the raw bytes were signed', () => {
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(
      rejection(() => verifyWebhook(reformatted, header(nowSeconds, secret), [secret], NOW)),
    ).toBe('bad_signature');
  });

  it('refuses a signature made with another secret', () => {
    const forged = header(nowSeconds, randomBytes(32).toString('hex'));
    expect(rejection(() => verifyWebhook(body, forged, [secret], NOW))).toBe('bad_signature');
  });

  it('refuses replays outside the tolerance window', () => {
    const old = nowSeconds - TOLERANCE_SECONDS - 1;
    expect(rejection(() => verifyWebhook(body, header(old, secret), [secret], NOW))).toBe(
      'timestamp_out_of_range',
    );
    const future = nowSeconds + TOLERANCE_SECONDS + 1;
    expect(rejection(() => verifyWebhook(body, header(future, secret), [secret], NOW))).toBe(
      'timestamp_out_of_range',
    );
    const edge = nowSeconds - TOLERANCE_SECONDS;
    expect(() => verifyWebhook(body, header(edge, secret), [secret], NOW)).not.toThrow();
  });

  it('supports secret rotation: either secret verifies during the overlap', () => {
    const both = [secret, previousSecret];
    expect(() => verifyWebhook(body, header(nowSeconds, previousSecret), both, NOW)).not.toThrow();
    expect(() => verifyWebhook(body, header(nowSeconds, secret), both, NOW)).not.toThrow();
    // A provider may sign with both secrets while it rotates.
    expect(() =>
      verifyWebhook(body, header(nowSeconds, previousSecret, secret), [secret], NOW),
    ).not.toThrow();
  });

  it('ignores unknown signature schemes instead of trusting them', () => {
    const legacyOnly = `t=${nowSeconds},v0=${computeSignature(secret, nowSeconds, body).toString('hex')}`;
    expect(rejection(() => verifyWebhook(body, legacyOnly, [secret], NOW))).toBe(
      'malformed_signature',
    );
  });
});
