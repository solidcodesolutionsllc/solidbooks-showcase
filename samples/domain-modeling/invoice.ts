/**
 * Invoice domain modeling with TypeScript and Zod.
 *
 * One schema describes what the API accepts. Zod validates untrusted input at
 * the boundary, and the same schema gives the TypeScript type used everywhere
 * behind it, so the validation rules and the types cannot drift apart.
 *
 * The rest is pure functions: no I/O, no clock (today's date is passed in), so
 * every rule is deterministic and directly testable.
 *
 * Adapted from the SolidBooks production code base. © Solid Code Solutions LLC.
 */
import { z } from 'zod';
import { isIsoDate } from '../double-entry/journal.js';
import { assertCents, multiplyQuantity, type Cents } from '../money/money.js';

// --- Input schemas -----------------------------------------------------------

const IsoDate = z.string().refine(isIsoDate, 'Use a real date in YYYY-MM-DD form');
const SignedCents = z.number().int();

export const PAYMENT_TERMS = [
  { days: 0, label: 'Due on receipt' },
  { days: 7, label: 'Net 7' },
  { days: 15, label: 'Net 15' },
  { days: 30, label: 'Net 30' },
  { days: 45, label: 'Net 45' },
  { days: 60, label: 'Net 60' },
] as const;

export const InvoiceLineInputSchema = z.object({
  description: z.string().trim().min(1, 'Describe the work').max(1000),
  /** Scaled integer, three decimals: 1.5 hours = 1500. Always positive. */
  quantityMilli: z.number().int().positive(),
  /** May be negative for a discount line. */
  rateCents: SignedCents,
});

export const InvoiceDraftSchema = z.object({
  customerId: z.uuid(),
  issueDate: IsoDate,
  paymentTermsDays: z
    .number()
    .int()
    .refine((days) => PAYMENT_TERMS.some((terms) => terms.days === days), 'Unknown payment terms'),
  memo: z
    .string()
    .trim()
    .max(4000)
    .nullish()
    .transform((memo) => memo || null),
  lines: z.array(InvoiceLineInputSchema).min(1, 'Add at least one line').max(200),
});

export type InvoiceLineInput = z.infer<typeof InvoiceLineInputSchema>;
export type InvoiceDraft = z.output<typeof InvoiceDraftSchema>;

// --- Totals ------------------------------------------------------------------

export interface InvoiceTotals {
  readonly lines: readonly (InvoiceLineInput & { readonly amountCents: Cents })[];
  readonly subtotalCents: Cents;
  readonly totalCents: Cents;
}

/**
 * Line amount = quantity × rate, rounded half away from zero. The server
 * always recomputes amounts and never trusts totals sent by a client.
 */
export function computeTotals(lines: readonly InvoiceLineInput[]): InvoiceTotals {
  let subtotalCents = 0;
  const priced = lines.map((line) => {
    const amountCents = multiplyQuantity(line.quantityMilli, line.rateCents);
    subtotalCents += amountCents;
    assertCents(subtotalCents, 'subtotal');
    return { ...line, amountCents };
  });
  if (subtotalCents < 0) throw new RangeError('discounts cannot exceed the invoice subtotal');
  return { lines: priced, subtotalCents, totalCents: subtotalCents };
}

// --- Calendar dates ----------------------------------------------------------
// Dates are calendar days ("2026-03-31"), not instants. Arithmetic happens in
// UTC so time zones and daylight-saving changes can never shift a due date.

const toUtc = (iso: string) => new Date(`${iso}T00:00:00Z`);
const fromUtc = (date: Date) => date.toISOString().slice(0, 10);

export function addDays(iso: string, days: number): string {
  const date = toUtc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

export function dueDateFor(issueDate: string, paymentTermsDays: number): string {
  return addDays(issueDate, paymentTermsDays);
}

export function termsLabel(paymentTermsDays: number): string {
  return (
    PAYMENT_TERMS.find((terms) => terms.days === paymentTermsDays)?.label ??
    `Net ${paymentTermsDays}`
  );
}

// --- Status ------------------------------------------------------------------

/** What is stored. */
export type StoredStatus = 'draft' | 'approved' | 'sent' | 'void';

/** What the user sees: stored state, plus what the balance and the calendar say. */
export type DisplayStatus = 'draft' | 'approved' | 'sent' | 'partial' | 'paid' | 'overdue' | 'void';

/**
 * "Paid", "partial" and "overdue" are never stored: they are derived from the
 * live balance and today's date, so they can never go stale.
 */
export function displayStatus(invoice: {
  readonly status: StoredStatus;
  readonly totalCents: Cents;
  readonly balanceCents: Cents;
  readonly dueDate: string;
  readonly today: string;
}): DisplayStatus {
  if (invoice.status === 'draft' || invoice.status === 'void') return invoice.status;
  if (invoice.balanceCents <= 0) return 'paid';
  if (invoice.dueDate < invoice.today) return 'overdue';
  if (invoice.balanceCents < invoice.totalCents) return 'partial';
  return invoice.status;
}

// --- Receivables aging ---------------------------------------------------------

export const AGING_BUCKETS = [
  'current',
  'days1To30',
  'days31To60',
  'days61To90',
  'over90',
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const daysLate = daysBetween(dueDate, asOf);
  if (daysLate <= 0) return 'current';
  if (daysLate <= 30) return 'days1To30';
  if (daysLate <= 60) return 'days31To60';
  if (daysLate <= 90) return 'days61To90';
  return 'over90';
}

// --- Recurring schedules -------------------------------------------------------

export type Frequency = 'monthly' | 'yearly';

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** The billing date in a month, clamped to the month's length (the 31st → Feb 28). */
export function billingDate(year: number, month0: number, dayOfMonth: number): string {
  return fromUtc(new Date(Date.UTC(year, month0, Math.min(dayOfMonth, daysInMonth(year, month0)))));
}

/**
 * The billing date after `previous`, keeping the schedule's own day of month.
 * Clamping is applied per month and never carried forward: a schedule on the
 * 31st bills Jan 31, Feb 28, Mar 31, not Mar 28.
 */
export function nextBillingDate(
  previous: string,
  frequency: Frequency,
  dayOfMonth: number,
): string {
  const date = toUtc(previous);
  const year = date.getUTCFullYear();
  const month0 = date.getUTCMonth();
  return frequency === 'monthly'
    ? billingDate(month0 === 11 ? year + 1 : year, (month0 + 1) % 12, dayOfMonth)
    : billingDate(year + 1, month0, dayOfMonth);
}

/**
 * The period a billing run covers ("2026-03" or "2026"). It is the
 * schedule's idempotency key: a period is billed at most once, however many
 * times the scheduled job runs.
 */
export function billingPeriod(runDate: string, frequency: Frequency): string {
  return frequency === 'monthly' ? runDate.slice(0, 7) : runDate.slice(0, 4);
}
