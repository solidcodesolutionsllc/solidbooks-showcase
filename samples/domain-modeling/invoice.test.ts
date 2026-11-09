import { describe, expect, it } from 'vitest';
import {
  agingBucket,
  billingDate,
  billingPeriod,
  computeTotals,
  displayStatus,
  dueDateFor,
  InvoiceDraftSchema,
  nextBillingDate,
  termsLabel,
} from './invoice.js';

const draft = {
  customerId: '7d1c0b3e-2f4a-4c55-9a7e-0c9f5e2b8a11',
  issueDate: '2026-03-02',
  paymentTermsDays: 15,
  memo: '  Thank you for your business.  ',
  lines: [
    { description: 'Website maintenance retainer', quantityMilli: 1000, rateCents: 52500 },
    { description: 'Design consultation', quantityMilli: 1500, rateCents: 12500 },
  ],
};

describe('InvoiceDraftSchema', () => {
  it('accepts a valid draft and normalizes it', () => {
    const parsed = InvoiceDraftSchema.parse(draft);
    expect(parsed.memo).toBe('Thank you for your business.');
    expect(InvoiceDraftSchema.parse({ ...draft, memo: '   ' }).memo).toBeNull();
  });

  it('explains what is wrong, field by field', () => {
    const result = InvoiceDraftSchema.safeParse({
      ...draft,
      issueDate: '2026-02-30',
      paymentTermsDays: 10,
      lines: [{ description: '', quantityMilli: 0, rateCents: 12.5 }],
    });
    expect(result.success).toBe(false);
    const problems = result.error?.issues.map((issue) => [issue.path.join('.'), issue.message]);
    expect(problems).toEqual(
      expect.arrayContaining([
        ['issueDate', 'Use a real date in YYYY-MM-DD form'],
        ['paymentTermsDays', 'Unknown payment terms'],
        ['lines.0.description', 'Describe the work'],
      ]),
    );
    expect(problems?.map(([path]) => path)).toEqual(
      expect.arrayContaining(['lines.0.quantityMilli', 'lines.0.rateCents']),
    );
  });

  it('requires at least one line', () => {
    expect(InvoiceDraftSchema.safeParse({ ...draft, lines: [] }).success).toBe(false);
  });
});

describe('computeTotals', () => {
  it('prices each line and totals them in integer cents', () => {
    const totals = computeTotals(draft.lines);
    expect(totals.lines.map((line) => line.amountCents)).toEqual([52500, 18750]);
    expect(totals.totalCents).toBe(71250);
  });

  it('supports discount lines but never a negative invoice', () => {
    const withDiscount = computeTotals([
      ...draft.lines,
      { description: 'Loyalty discount', quantityMilli: 1000, rateCents: -7125 },
    ]);
    expect(withDiscount.totalCents).toBe(64125);
    expect(() =>
      computeTotals([{ description: 'Credit', quantityMilli: 1000, rateCents: -100 }]),
    ).toThrow(RangeError);
  });
});

describe('payment terms and due dates', () => {
  it('computes due dates across month and year ends', () => {
    expect(dueDateFor('2026-03-02', 15)).toBe('2026-03-17');
    expect(dueDateFor('2026-12-20', 30)).toBe('2027-01-19');
    expect(dueDateFor('2028-02-14', 15)).toBe('2028-02-29'); // leap year
    expect(dueDateFor('2026-03-02', 0)).toBe('2026-03-02');
  });

  it('labels terms the way customers read them', () => {
    expect(termsLabel(0)).toBe('Due on receipt');
    expect(termsLabel(30)).toBe('Net 30');
  });
});

describe('displayStatus', () => {
  const sent = { status: 'sent' as const, totalCents: 52500, dueDate: '2026-03-17' };

  it('derives paid, partial and overdue from the balance and the date', () => {
    expect(displayStatus({ ...sent, balanceCents: 52500, today: '2026-03-10' })).toBe('sent');
    expect(displayStatus({ ...sent, balanceCents: 20000, today: '2026-03-10' })).toBe('partial');
    expect(displayStatus({ ...sent, balanceCents: 20000, today: '2026-03-18' })).toBe('overdue');
    expect(displayStatus({ ...sent, balanceCents: 0, today: '2026-04-30' })).toBe('paid');
  });

  it('keeps draft and void as they are', () => {
    expect(
      displayStatus({ ...sent, status: 'void', balanceCents: 52500, today: '2026-05-01' }),
    ).toBe('void');
  });
});

describe('agingBucket', () => {
  it.each([
    ['2026-03-17', 'current'],
    ['2026-03-18', 'days1To30'],
    ['2026-04-16', 'days1To30'],
    ['2026-04-17', 'days31To60'],
    ['2026-06-15', 'days61To90'],
    ['2026-06-16', 'over90'],
  ])('as of %s an invoice due 2026-03-17 is %s', (asOf, bucket) => {
    expect(agingBucket('2026-03-17', asOf)).toBe(bucket);
  });
});

describe('recurring billing dates', () => {
  it('clamps the 31st to short months without drifting', () => {
    const dates = ['2026-01-31'];
    for (let i = 0; i < 4; i++) dates.push(nextBillingDate(dates.at(-1)!, 'monthly', 31));
    expect(dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('handles leap years and the year boundary', () => {
    expect(billingDate(2028, 1, 30)).toBe('2028-02-29');
    expect(nextBillingDate('2026-12-15', 'monthly', 15)).toBe('2027-01-15');
    expect(nextBillingDate('2028-02-29', 'yearly', 29)).toBe('2029-02-28');
  });

  it('names the period each run bills, so a period is billed once', () => {
    expect(billingPeriod('2026-03-31', 'monthly')).toBe('2026-03');
    expect(billingPeriod('2026-03-31', 'yearly')).toBe('2026');
  });
});
