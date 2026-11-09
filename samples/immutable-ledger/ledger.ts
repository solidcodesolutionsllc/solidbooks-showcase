/**
 * Posting and reversing journal entries against the invariants in
 * invariants.sql, on PostgreSQL (in-memory PGlite for this sample).
 *
 * Each business command runs in exactly one transaction. The balance check is
 * deferred to COMMIT, so its error surfaces from `transaction()` and nothing
 * from the failed command is left behind.
 *
 * Adapted from the SolidBooks production code base. © Solid Code Solutions LLC.
 */
import { readFile } from 'node:fs/promises';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { JournalEntryDraft } from '../double-entry/journal.js';
import { reverseLines, validateJournalEntry } from '../double-entry/journal.js';

/** A ledger rule the database refused, with its SQLSTATE (SB001, SB002, SB006, ...). */
export class LedgerViolation extends Error {
  override readonly name = 'LedgerViolation';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Fresh in-memory database with the sample schema and invariants. */
export async function createLedgerDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const file of ['schema.sql', 'invariants.sql']) {
    await db.exec(await readFile(new URL(file, import.meta.url), 'utf8'));
  }
  return db;
}

/** Translate PostgreSQL errors raised by the invariants into `LedgerViolation`. */
export async function ledgerCommand<T>(
  db: PGlite,
  command: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(command);
  } catch (error) {
    if (error instanceof LedgerViolation) throw error;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SB')) {
      throw new LedgerViolation(code, (error as Error).message);
    }
    throw error;
  }
}

/** Insert an entry and its lines inside an open transaction. Returns the entry id. */
export async function insertEntry(
  tx: Transaction,
  entry: JournalEntryDraft,
  reversesEntryId: string | null = null,
): Promise<string> {
  const header = await tx.query<{ id: string }>(
    'INSERT INTO journal_entries (date, memo, reverses_entry_id) VALUES ($1, $2, $3) RETURNING id',
    [entry.date, entry.memo ?? null, reversesEntryId],
  );
  const id = header.rows[0]?.id;
  if (!id) throw new Error('journal entry was not created');
  for (const [index, line] of entry.lines.entries()) {
    await tx.query(
      `INSERT INTO journal_lines (entry_id, line_no, account_id, debit_cents, credit_cents)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, index + 1, line.accountId, line.debitCents, line.creditCents],
    );
  }
  return id;
}

/** Validate in the application first (clear messages), then let the database enforce. */
export async function postEntry(db: PGlite, entry: JournalEntryDraft): Promise<string> {
  const issues = validateJournalEntry(entry);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join('; '));
  }
  return ledgerCommand(db, (tx) => insertEntry(tx, entry));
}

/**
 * Correct a posted entry: post its mirror image and mark the original as
 * reversed, in one transaction. Both entries stay in the ledger forever.
 */
export async function reverseEntry(db: PGlite, entryId: string, date: string): Promise<string> {
  return ledgerCommand(db, async (tx) => {
    // Lock the original so two concurrent reversals can't both proceed. The
    // UNIQUE constraint on reverses_entry_id backs this up in the database.
    const original = await tx.query<{ entry_no: number; status: string }>(
      'SELECT entry_no, status FROM journal_entries WHERE id = $1 FOR UPDATE',
      [entryId],
    );
    const row = original.rows[0];
    if (!row) throw new Error(`journal entry ${entryId} does not exist`);
    if (row.status !== 'posted') {
      throw new LedgerViolation('SB002', `journal entry ${row.entry_no} is already reversed`);
    }
    const lines = await tx.query<{
      account_id: string;
      debit_cents: number;
      credit_cents: number;
    }>(
      `SELECT account_id, debit_cents::int AS debit_cents, credit_cents::int AS credit_cents
       FROM journal_lines WHERE entry_id = $1 ORDER BY line_no`,
      [entryId],
    );
    const reversalId = await insertEntry(
      tx,
      {
        date,
        memo: `Reversal of entry ${row.entry_no}`,
        lines: reverseLines(
          lines.rows.map((line) => ({
            accountId: line.account_id,
            debitCents: line.debit_cents,
            creditCents: line.credit_cents,
          })),
        ),
      },
      entryId,
    );
    await tx.query(
      `UPDATE journal_entries SET status = 'reversed', reversed_by_entry_id = $1 WHERE id = $2`,
      [reversalId, entryId],
    );
    return reversalId;
  });
}

/** Total debits and credits across the whole ledger (always equal). */
export async function trialBalance(db: PGlite) {
  const result = await db.query<{ debits: number; credits: number }>(
    `SELECT coalesce(sum(debit_cents), 0)::int AS debits,
            coalesce(sum(credit_cents), 0)::int AS credits
     FROM journal_lines`,
  );
  return result.rows[0] ?? { debits: 0, credits: 0 };
}
