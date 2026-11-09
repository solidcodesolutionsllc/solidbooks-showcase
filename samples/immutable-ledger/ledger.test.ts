import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JournalEntryDraft } from '../double-entry/journal.js';
import {
  createLedgerDb,
  insertEntry,
  ledgerCommand,
  LedgerViolation,
  postEntry,
  reverseEntry,
  trialBalance,
} from './ledger.js';

let db: PGlite;

const invoice: JournalEntryDraft = {
  date: '2026-04-01',
  memo: 'INV-1001 Example Client',
  lines: [
    { accountId: 'receivable', debitCents: 120000, creditCents: 0 },
    { accountId: 'income', debitCents: 0, creditCents: 120000 },
  ],
};

beforeEach(async () => {
  db = await createLedgerDb();
  await db.exec(`
    INSERT INTO accounts (id, name, type) VALUES
      ('checking',   'Operating Checking',  'asset'),
      ('receivable', 'Accounts Receivable', 'asset'),
      ('income',     'Design Income',       'income');
  `);
});

/** Run a command that the database must refuse; return the SQLSTATE it used. */
async function refusedWith(command: () => Promise<unknown>): Promise<string> {
  try {
    await command();
  } catch (error) {
    if (error instanceof LedgerViolation) return error.code;
    throw error;
  }
  throw new Error('the database accepted a change it should have refused');
}

const count = async (table: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n;

describe('balanced entries (checked at commit)', () => {
  it('commits a balanced entry', async () => {
    await postEntry(db, invoice);
    expect(await trialBalance(db)).toEqual({ debits: 120000, credits: 120000 });
  });

  it('refuses an unbalanced entry and leaves nothing behind', async () => {
    // Bypass the application check to prove the database enforces it on its own.
    const code = await refusedWith(() =>
      ledgerCommand(db, (tx) =>
        insertEntry(tx, {
          ...invoice,
          lines: [invoice.lines[0]!, { ...invoice.lines[1]!, creditCents: 119999 }],
        }),
      ),
    );
    expect(code).toBe('SB001');
    expect(await count('journal_entries')).toBe(0);
    expect(await count('journal_lines')).toBe(0);
  });

  it('refuses an entry with a single line', async () => {
    const code = await refusedWith(() =>
      ledgerCommand(db, (tx) => insertEntry(tx, { ...invoice, lines: [invoice.lines[0]!] })),
    );
    expect(code).toBe('SB001');
  });

  it('allows lines in any order within the transaction', async () => {
    await ledgerCommand(db, async (tx) => {
      const id = await insertEntry(tx, { ...invoice, lines: [invoice.lines[0]!] });
      // Unbalanced at this moment; fine, because the check runs at COMMIT.
      await tx.query(
        `INSERT INTO journal_lines (entry_id, line_no, account_id, credit_cents)
         VALUES ($1, 2, 'income', 120000)`,
        [id],
      );
    });
    expect(await trialBalance(db)).toEqual({ debits: 120000, credits: 120000 });
  });
});

describe('sealed entries', () => {
  it('refuses lines added to an entry by a later transaction, even balanced ones', async () => {
    const id = await postEntry(db, invoice);
    const code = await refusedWith(() =>
      ledgerCommand(db, async (tx) => {
        await tx.query(
          `INSERT INTO journal_lines (entry_id, line_no, account_id, debit_cents, credit_cents)
           VALUES ($1, 3, 'checking', 5000, 0), ($1, 4, 'income', 0, 5000)`,
          [id],
        );
      }),
    );
    expect(code).toBe('SB006');
  });
});

describe('immutability', () => {
  it('refuses to edit or delete posted lines', async () => {
    await postEntry(db, invoice);
    expect(
      await refusedWith(() =>
        ledgerCommand(db, (tx) =>
          tx.query('UPDATE journal_lines SET debit_cents = 1 WHERE line_no = 1'),
        ),
      ),
    ).toBe('SB002');
    expect(
      await refusedWith(() => ledgerCommand(db, (tx) => tx.query('DELETE FROM journal_lines'))),
    ).toBe('SB002');
  });

  it('refuses to delete, truncate or rewrite an entry', async () => {
    await postEntry(db, invoice);
    expect(
      await refusedWith(() => ledgerCommand(db, (tx) => tx.query('DELETE FROM journal_entries'))),
    ).toBe('SB002');
    expect(
      await refusedWith(() => ledgerCommand(db, (tx) => tx.query('TRUNCATE journal_lines'))),
    ).toBe('SB002');
    expect(
      await refusedWith(() =>
        ledgerCommand(db, (tx) => tx.query(`UPDATE journal_entries SET date = '2026-01-01'`)),
      ),
    ).toBe('SB002');
  });
});

describe('corrections by reversal', () => {
  it('reverses an entry, keeping both in the ledger', async () => {
    const original = await postEntry(db, invoice);
    const reversal = await reverseEntry(db, original, '2026-04-03');

    const entries = await db.query<{ id: string; status: string; reversed_by_entry_id: string }>(
      'SELECT id, status, reversed_by_entry_id FROM journal_entries ORDER BY entry_no',
    );
    expect(entries.rows).toEqual([
      { id: original, status: 'reversed', reversed_by_entry_id: reversal },
      { id: reversal, status: 'posted', reversed_by_entry_id: null },
    ]);
    // Receivable and income are back to zero, and the history shows why.
    const balances = await db.query<{ account_id: string; net: number }>(
      `SELECT account_id, sum(debit_cents - credit_cents)::int AS net
       FROM journal_lines GROUP BY account_id ORDER BY account_id`,
    );
    expect(balances.rows).toEqual([
      { account_id: 'income', net: 0 },
      { account_id: 'receivable', net: 0 },
    ]);
  });

  it('refuses to reverse the same entry twice', async () => {
    const original = await postEntry(db, invoice);
    await reverseEntry(db, original, '2026-04-03');
    expect(await refusedWith(() => reverseEntry(db, original, '2026-04-04'))).toBe('SB002');
  });

  it('refuses to mark an entry reversed without a real reversing entry', async () => {
    const original = await postEntry(db, invoice);
    const unrelated = await postEntry(db, { ...invoice, memo: 'Another invoice' });
    const code = await refusedWith(() =>
      ledgerCommand(db, (tx) =>
        tx.query(
          `UPDATE journal_entries SET status = 'reversed', reversed_by_entry_id = $1 WHERE id = $2`,
          [unrelated, original],
        ),
      ),
    );
    expect(code).toBe('SB002');
  });
});
