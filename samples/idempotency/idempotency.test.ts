import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  IDEMPOTENCY_SCHEMA,
  IDEMPOTENCY_TTL_MS,
  IdempotencyError,
  withIdempotency,
  type CommandResult,
} from './idempotency.js';
import type { Transaction } from '@electric-sql/pglite';

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(IDEMPOTENCY_SCHEMA);
  await db.exec(`
    CREATE TABLE payments (
      id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      customer     text NOT NULL,
      amount_cents integer NOT NULL
    );
  `);
});

interface Payment {
  id: number;
  customer: string;
  amountCents: number;
}

/** The command under test: record a payment. */
const recordPayment =
  (customer: string, amountCents: number) =>
  async (tx: Transaction): Promise<CommandResult<Payment>> => {
    const result = await tx.query<{ id: number }>(
      'INSERT INTO payments (customer, amount_cents) VALUES ($1, $2) RETURNING id',
      [customer, amountCents],
    );
    return { status: 201, body: { id: result.rows[0]!.id, customer, amountCents } };
  };

const request = (key: string | undefined, body: unknown = { amountCents: 52500 }) => ({
  userId: 'owner',
  key,
  fingerprint: { method: 'POST', route: '/payments', body },
});

const paymentCount = async () =>
  (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM payments')).rows[0]?.n;

describe('withIdempotency', () => {
  it('runs the command once and replays the response for a retry', async () => {
    const first = await withIdempotency(
      db,
      request('pay-7f3a9c21'),
      recordPayment('Example Client', 52500),
    );
    const retry = await withIdempotency(
      db,
      request('pay-7f3a9c21'),
      recordPayment('Example Client', 52500),
    );

    expect(first).toMatchObject({ status: 201, replayed: false });
    expect(retry).toEqual({ ...first, replayed: true });
    expect(await paymentCount()).toBe(1);
  });

  it('treats different keys as different requests', async () => {
    await withIdempotency(db, request('pay-00000001'), recordPayment('Example Client', 52500));
    await withIdempotency(db, request('pay-00000002'), recordPayment('Example Client', 52500));
    expect(await paymentCount()).toBe(2);
  });

  it('refuses a key reused for a different request', async () => {
    await withIdempotency(db, request('pay-7f3a9c21'), recordPayment('Example Client', 52500));
    const reuse = withIdempotency(
      db,
      request('pay-7f3a9c21', { amountCents: 99900 }),
      recordPayment('Example Client', 99900),
    );
    await expect(reuse).rejects.toMatchObject({ code: 'key_reused', status: 422 });
    expect(await paymentCount()).toBe(1);
  });

  it('keeps no claim when the command fails, so the client can retry', async () => {
    const failing = withIdempotency(db, request('pay-retry-001'), () =>
      Promise.reject(new Error('card processor unavailable')),
    );
    await expect(failing).rejects.toThrow('card processor unavailable');

    const retry = await withIdempotency(
      db,
      request('pay-retry-001'),
      recordPayment('Example Client', 52500),
    );
    expect(retry.replayed).toBe(false);
    expect(await paymentCount()).toBe(1);
  });

  it('runs concurrent duplicates once: the second waits, then replays', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withIdempotency(db, request('pay-double-click'), recordPayment('Example Client', 52500)),
      ),
    );
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
    expect(await paymentCount()).toBe(1);
  });

  it('requires a well-formed key', async () => {
    for (const key of [undefined, '', 'short', 'has spaces in it', 'x'.repeat(129)]) {
      await expect(
        withIdempotency(db, request(key), recordPayment('Example Client', 52500)),
      ).rejects.toBeInstanceOf(IdempotencyError);
    }
    expect(await paymentCount()).toBe(0);
  });

  it('forgets keys after their retention window', async () => {
    const start = new Date('2026-05-01T12:00:00Z');
    await withIdempotency(
      db,
      request('pay-expiring'),
      recordPayment('Example Client', 52500),
      start,
    );
    const later = new Date(start.getTime() + IDEMPOTENCY_TTL_MS + 1);
    const again = await withIdempotency(
      db,
      request('pay-expiring'),
      recordPayment('Example Client', 52500),
      later,
    );
    expect(again.replayed).toBe(false);
  });
});
