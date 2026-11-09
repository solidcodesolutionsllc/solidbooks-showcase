/**
 * Double-entry journal validation.
 *
 * Every financial event in SolidBooks becomes a journal entry: two or more
 * lines, each a debit or a credit to one account, with debits equal to
 * credits. This module validates a draft entry before it reaches the
 * database and explains every problem it finds. The database enforces the
 * same rules again (see ../immutable-ledger), so a bug here can produce a
 * clear error message, but never an unbalanced ledger.
 *
 * Adapted from the SolidBooks production code base. © Solid Code Solutions LLC.
 */
import type { Cents } from '../money/money.js';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface JournalLineDraft {
  readonly accountId: string;
  readonly debitCents: Cents;
  readonly creditCents: Cents;
  readonly memo?: string;
}

export interface JournalEntryDraft {
  /** Calendar date, YYYY-MM-DD. */
  readonly date: string;
  readonly memo?: string;
  readonly lines: readonly JournalLineDraft[];
}

/** Machine-readable codes, so the API and the UI can react to each problem. */
export type JournalIssueCode =
  | 'invalid_date'
  | 'too_few_lines'
  | 'missing_account'
  | 'amount_not_integer'
  | 'amount_negative'
  | 'line_must_have_one_side'
  | 'unbalanced'
  | 'zero_total';

export interface JournalIssue {
  readonly code: JournalIssueCode;
  readonly lineIndex?: number;
  readonly message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function journalTotals(lines: readonly JournalLineDraft[]) {
  let debitCents = 0;
  let creditCents = 0;
  for (const line of lines) {
    debitCents += line.debitCents;
    creditCents += line.creditCents;
  }
  return { debitCents, creditCents };
}

/**
 * Every problem with a draft entry, or an empty list when it can be posted.
 * Collecting all issues (instead of throwing on the first) lets the editor
 * highlight every faulty line at once.
 */
export function validateJournalEntry(entry: JournalEntryDraft): JournalIssue[] {
  const issues: JournalIssue[] = [];
  if (!isIsoDate(entry.date)) {
    issues.push({ code: 'invalid_date', message: `"${entry.date}" is not a valid date` });
  }
  if (entry.lines.length < 2) {
    issues.push({ code: 'too_few_lines', message: 'a journal entry needs at least two lines' });
  }

  let amountsUsable = true;
  for (const [lineIndex, line] of entry.lines.entries()) {
    if (!line.accountId) {
      issues.push({ code: 'missing_account', lineIndex, message: 'the line has no account' });
    }
    const amounts = [line.debitCents, line.creditCents];
    if (!amounts.every((amount) => Number.isSafeInteger(amount))) {
      amountsUsable = false;
      issues.push({ code: 'amount_not_integer', lineIndex, message: 'use integer cents' });
      continue;
    }
    if (amounts.some((amount) => amount < 0)) {
      amountsUsable = false;
      issues.push({ code: 'amount_negative', lineIndex, message: 'amounts cannot be negative' });
      continue;
    }
    if (amounts.filter((amount) => amount > 0).length !== 1) {
      issues.push({
        code: 'line_must_have_one_side',
        lineIndex,
        message: 'each line is either a debit or a credit',
      });
    }
  }
  // Totals of fractional or negative amounts would only add confusing noise.
  if (!amountsUsable) return issues;

  const { debitCents, creditCents } = journalTotals(entry.lines);
  if (debitCents !== creditCents) {
    issues.push({
      code: 'unbalanced',
      message: `debits (${debitCents}) must equal credits (${creditCents})`,
    });
  } else if (debitCents === 0) {
    issues.push({ code: 'zero_total', message: 'a journal entry cannot total zero' });
  }
  return issues;
}

/**
 * The lines of a reversing entry. Posted entries are never edited or
 * deleted; a correction is a new entry with every debit and credit swapped,
 * followed (if needed) by the corrected entry.
 */
export function reverseLines(lines: readonly JournalLineDraft[]): JournalLineDraft[] {
  return lines.map((line) => ({
    ...line,
    debitCents: line.creditCents,
    creditCents: line.debitCents,
  }));
}

/** The side on which an account type normally carries its balance. */
export function normalSide(type: AccountType): 'debit' | 'credit' {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

/** An account's balance expressed on its normal side (positive when normal). */
export function naturalBalance(type: AccountType, debitCents: Cents, creditCents: Cents): Cents {
  return normalSide(type) === 'debit' ? debitCents - creditCents : creditCents - debitCents;
}
