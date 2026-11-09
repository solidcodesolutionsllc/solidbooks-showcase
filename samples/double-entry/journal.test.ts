import { describe, expect, it } from 'vitest';
import {
  isIsoDate,
  journalTotals,
  naturalBalance,
  normalSide,
  reverseLines,
  validateJournalEntry,
  type JournalEntryDraft,
} from './journal.js';

/** A $1,000.00 invoice to a fictional client: receivable up, income up. */
const invoice: JournalEntryDraft = {
  date: '2026-03-02',
  memo: 'INV-1001 Example Client',
  lines: [
    { accountId: 'accounts-receivable', debitCents: 100000, creditCents: 0 },
    { accountId: 'design-income', debitCents: 0, creditCents: 100000 },
  ],
};

const codes = (entry: JournalEntryDraft) => validateJournalEntry(entry).map((issue) => issue.code);

describe('validateJournalEntry', () => {
  it('accepts a balanced entry', () => {
    expect(validateJournalEntry(invoice)).toEqual([]);
  });

  it('accepts a split entry with several lines', () => {
    // A $1,000.00 payment: $970.90 deposited, $29.10 card processing fee.
    const payment: JournalEntryDraft = {
      date: '2026-03-10',
      lines: [
        { accountId: 'checking', debitCents: 97090, creditCents: 0 },
        { accountId: 'processing-fees', debitCents: 2910, creditCents: 0 },
        { accountId: 'accounts-receivable', debitCents: 0, creditCents: 100000 },
      ],
    };
    expect(validateJournalEntry(payment)).toEqual([]);
  });

  it('rejects an unbalanced entry, saying by how much', () => {
    const [receivable, income] = invoice.lines;
    const issues = validateJournalEntry({
      ...invoice,
      lines: [receivable!, { ...income!, creditCents: 99999 }],
    });
    expect(issues).toEqual([
      { code: 'unbalanced', message: 'debits (100000) must equal credits (99999)' },
    ]);
  });

  it('rejects single-line and zero-total entries', () => {
    expect(codes({ ...invoice, lines: invoice.lines.slice(0, 1) })).toContain('too_few_lines');
    expect(
      codes({
        ...invoice,
        lines: [
          { accountId: 'a', debitCents: 0, creditCents: 0 },
          { accountId: 'b', debitCents: 0, creditCents: 0 },
        ],
      }),
    ).toContain('zero_total');
  });

  it('reports every faulty line at once, with its index', () => {
    const issues = validateJournalEntry({
      ...invoice,
      lines: [
        { accountId: 'a', debitCents: 100, creditCents: 100 },
        { accountId: '', debitCents: 0, creditCents: 200 },
      ],
    });
    expect(issues.map((issue) => [issue.code, issue.lineIndex])).toEqual([
      ['line_must_have_one_side', 0],
      ['missing_account', 1],
      ['unbalanced', undefined],
    ]);
  });

  it('rejects negative and fractional amounts before totalling', () => {
    expect(
      codes({
        ...invoice,
        lines: [
          { accountId: 'a', debitCents: -100, creditCents: 0 },
          { accountId: 'b', debitCents: 0, creditCents: -100 },
        ],
      }),
    ).toEqual(['amount_negative', 'amount_negative']);
    expect(
      codes({
        ...invoice,
        lines: [
          { accountId: 'a', debitCents: 10.5, creditCents: 0 },
          { accountId: 'b', debitCents: 0, creditCents: 10.5 },
        ],
      }),
    ).toEqual(['amount_not_integer', 'amount_not_integer']);
  });

  it('rejects dates that do not exist', () => {
    expect(codes({ ...invoice, date: '2026-02-30' })).toEqual(['invalid_date']);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-2-3')).toBe(false);
  });
});

describe('reverseLines', () => {
  it('produces a balanced mirror image that cancels the original', () => {
    const reversal = { ...invoice, lines: reverseLines(invoice.lines) };
    expect(validateJournalEntry(reversal)).toEqual([]);
    const both = journalTotals([...invoice.lines, ...reversal.lines]);
    expect(both.debitCents).toBe(both.creditCents);
    expect(reversal.lines[0]).toMatchObject({ debitCents: 0, creditCents: 100000 });
  });
});

describe('normal balances', () => {
  it('derives the normal side from the account type', () => {
    expect(normalSide('asset')).toBe('debit');
    expect(normalSide('expense')).toBe('debit');
    expect(normalSide('liability')).toBe('credit');
    expect(normalSide('equity')).toBe('credit');
    expect(normalSide('income')).toBe('credit');
    expect(naturalBalance('asset', 50000, 20000)).toBe(30000);
    expect(naturalBalance('income', 0, 100000)).toBe(100000);
  });
});
