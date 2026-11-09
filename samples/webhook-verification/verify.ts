/**
 * Verifying signed webhooks.
 *
 * Payment and banking providers notify SolidBooks through webhooks: plain
 * HTTPS requests from the internet. Anyone can send a request to that URL, so
 * nothing in a webhook is trusted until its signature is verified.
 *
 * This is an original, dependency-free illustration of the timestamped
 * HMAC-SHA256 scheme that payment providers commonly use (header format
 * `t=<unix seconds>,v1=<hex signature>[,v1=...]`, signed over
 * `<timestamp>.<raw body>`). In production SolidBooks delegates this to each
 * provider's official library; the principles are the same:
 *
 * 1. Verify the **raw** request bytes. Re-serialized JSON is not the payload
 *    that was signed.
 * 2. Compare signatures in **constant time**, so response timing reveals
 *    nothing about how much of a forged signature matched.
 * 3. Reject old timestamps, so a captured request cannot be **replayed** later.
 * 4. Accept several secrets, so a secret can be **rotated** without downtime.
 * 5. Say **why** a webhook was refused (for logs), but never log its body.
 *
 * © Solid Code Solutions LLC.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Signatures older (or further in the future) than this are refused. */
export const TOLERANCE_SECONDS = 300;

export type WebhookRejection =
  'missing_signature' | 'malformed_signature' | 'timestamp_out_of_range' | 'bad_signature';

export class WebhookVerificationError extends Error {
  override readonly name = 'WebhookVerificationError';
  constructor(readonly reason: WebhookRejection) {
    super(`webhook refused: ${reason}`);
  }
}

export interface VerifiedWebhook {
  readonly timestamp: number;
  readonly payload: unknown;
}

interface ParsedHeader {
  readonly timestamp: number;
  readonly signatures: readonly Buffer[];
}

function parseHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: Buffer[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) return null;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === 't') {
      if (!/^\d{1,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (name === 'v1') {
      if (!/^[0-9a-f]{64}$/.test(value)) return null;
      signatures.push(Buffer.from(value, 'hex'));
    }
    // Other schemes (for example a legacy `v0`) are ignored, never trusted.
  }
  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

export function computeSignature(secret: string, timestamp: number, rawBody: Buffer): Buffer {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
}

/**
 * Verify a webhook and return its parsed payload, or throw a
 * `WebhookVerificationError` with the reason. Answer 400 on failure.
 */
export function verifyWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secrets: readonly string[],
  nowMs: number = Date.now(),
): VerifiedWebhook {
  if (!signatureHeader) throw new WebhookVerificationError('missing_signature');
  const parsed = parseHeader(signatureHeader);
  if (!parsed) throw new WebhookVerificationError('malformed_signature');

  const ageSeconds = Math.floor(nowMs / 1000) - parsed.timestamp;
  if (Math.abs(ageSeconds) > TOLERANCE_SECONDS) {
    throw new WebhookVerificationError('timestamp_out_of_range');
  }

  const matches = secrets.some((secret) => {
    const expected = computeSignature(secret, parsed.timestamp, rawBody);
    return parsed.signatures.some(
      (candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );
  });
  if (!matches) throw new WebhookVerificationError('bad_signature');

  // Only now is the body worth parsing.
  return { timestamp: parsed.timestamp, payload: JSON.parse(rawBody.toString('utf8')) as unknown };
}
