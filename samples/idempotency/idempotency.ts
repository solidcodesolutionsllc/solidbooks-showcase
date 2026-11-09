/**
 * Exactly-once command processing with an Idempotency-Key.
 *
 * Networks fail after the server has done the work but before the client
 * hears back, so clients retry. For "create invoice" or "record payment", a
 * retry must never create a second invoice or a second payment. Every create
 * request carries an Idempotency-Key, and the server runs the command at most
 * once per key:
 *
 * - The key is claimed in the same transaction as the command, so it is only
 *   stored if the command commits. A failed attempt can be retried with the
 *   same key.
 * - A retry with the same key and the same request replays the stored
 *   response instead of running the command again.
 * - Reusing a key for a different request is refused, not silently replayed.
 * - A concurrent duplicate waits on the key row's lock, then replays.
 *
 * Adapted from the SolidBooks production code base. © Solid Code Solutions LLC.
 */
import { createHash } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export const IDEMPOTENCY_SCHEMA = `
  CREATE TABLE idempotency_keys (
    user_id         text NOT NULL,
    key             text NOT NULL,
    request_hash    text NOT NULL,
    response_status integer,
    response_body   jsonb,
    expires_at      timestamptz NOT NULL,
    PRIMARY KEY (user_id, key)
  );
`;

export type IdempotencyErrorCode = 'key_required' | 'key_reused' | 'in_progress';

export class IdempotencyError extends Error {
  override readonly name = 'IdempotencyError';
  constructor(
    readonly code: IdempotencyErrorCode,
    /** The HTTP status the API answers with. */
    readonly status: 400 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

export interface IdempotentRequest {
  readonly userId: string;
  readonly key: string | undefined;
  /** Method, route and body: a key reused with a different request is refused. */
  readonly fingerprint: unknown;
}

export interface CommandResult<T> {
  readonly status: number;
  readonly body: T;
}

export interface IdempotentResult<T> extends CommandResult<T> {
  readonly replayed: boolean;
}

export async function withIdempotency<T>(
  db: PGlite,
  request: IdempotentRequest,
  command: (tx: Transaction) => Promise<CommandResult<T>>,
  now: Date = new Date(),
): Promise<IdempotentResult<T>> {
  const { key, userId } = request;
  if (!key || !KEY_PATTERN.test(key)) {
    throw new IdempotencyError(
      'key_required',
      400,
      'Send a unique Idempotency-Key (8–128 letters, digits, _ . : -) with each create request.',
    );
  }
  const requestHash = createHash('sha256')
    .update(JSON.stringify(request.fingerprint))
    .digest('hex');

  return db.transaction(async (tx) => {
    await tx.query('DELETE FROM idempotency_keys WHERE expires_at < $1', [now]);
    // Claim the key. If another transaction holds it, this waits for it to
    // commit or roll back; either way the outcome below is correct.
    const claimed = await tx.query(
      `INSERT INTO idempotency_keys (user_id, key, request_hash, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING
       RETURNING key`,
      [userId, key, requestHash, new Date(now.getTime() + IDEMPOTENCY_TTL_MS)],
    );

    if (claimed.rows.length === 0) {
      const existing = await tx.query<{
        request_hash: string;
        response_status: number | null;
        response_body: T;
      }>(
        `SELECT request_hash, response_status, response_body
         FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [userId, key],
      );
      const row = existing.rows[0];
      if (!row || row.response_status === null) {
        throw new IdempotencyError(
          'in_progress',
          409,
          'A request with this Idempotency-Key is in progress',
        );
      }
      if (row.request_hash !== requestHash) {
        throw new IdempotencyError(
          'key_reused',
          422,
          'This Idempotency-Key was already used for a different request',
        );
      }
      return { status: row.response_status, body: row.response_body, replayed: true };
    }

    // Same transaction: if the command fails, the claim disappears with it.
    const result = await command(tx);
    await tx.query(
      `UPDATE idempotency_keys SET response_status = $1, response_body = $2
       WHERE user_id = $3 AND key = $4`,
      [result.status, JSON.stringify(result.body), userId, key],
    );
    return { ...result, replayed: false };
  });
}
