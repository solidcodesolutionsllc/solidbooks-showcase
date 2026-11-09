/**
 * Money as integer cents.
 *
 * Every amount in SolidBooks is an integer number of cents, from the browser
 * form to the database column. Floating-point dollars are never used: 0.1 +
 * 0.2 is not 0.3 in IEEE 754, and an accounting system cannot round its way
 * out of that.
 *
 * `number` is used rather than `bigint` so amounts serialize to JSON as-is.
 * Every operation asserts that the result is a safe integer (up to about
 * $90 trillion), and intermediate products are computed in `bigint`.
 *
 * Adapted from the SolidBooks production code base. © Solid Code Solutions LLC.
 */

/** An integer number of cents. */
export type Cents = number;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

export function assertCents(value: number, label = 'amount'): asserts value is Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${label} must be a safe integer number of cents, got ${value}`);
  }
}

export function addCents(...values: readonly Cents[]): Cents {
  let total = 0;
  for (const value of values) {
    assertCents(value);
    total += value;
    assertCents(total, 'sum');
  }
  return total;
}

export function subtractCents(a: Cents, b: Cents): Cents {
  assertCents(a);
  assertCents(b);
  const difference = a - b;
  assertCents(difference, 'difference');
  return difference;
}

/** Round the ratio num/den half away from zero. `den` must be positive. */
function roundHalfAwayFromZero(num: bigint, den: bigint): bigint {
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const quotient = (abs * 2n + den) / (den * 2n);
  return negative ? -quotient : quotient;
}

/** Quantities are scaled integers with three decimals: 1.5 hours is 1500. */
export const QUANTITY_SCALE = 1000;

/**
 * Line amount = quantity × rate, rounded half away from zero to the cent.
 * The product is computed in `bigint`, so large quantities never overflow.
 */
export function multiplyQuantity(quantityMilli: number, rateCents: Cents): Cents {
  if (!Number.isSafeInteger(quantityMilli)) {
    throw new MoneyError(`quantity must be a scaled integer, got ${quantityMilli}`);
  }
  assertCents(rateCents, 'rate');
  const amount = Number(
    roundHalfAwayFromZero(BigInt(quantityMilli) * BigInt(rateCents), BigInt(QUANTITY_SCALE)),
  );
  assertCents(amount, 'line amount');
  return amount;
}

/**
 * Parse what a person types (or a bank export contains) into cents.
 * Accepts "$1,234.56", "-12.5", "(12.34)" (the accounting negative) and
 * "1234". Rejects anything with more than two decimals instead of rounding.
 */
export function parseMoney(input: string): Cents {
  let text = input.trim();
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  text = text.replace(/^\$/, '').replace(/,/g, '').trim();
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(text);
  if (!match) throw new MoneyError(`invalid money value: "${input}"`);
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const cents = Number(BigInt(whole) * 100n + BigInt(fraction));
  assertCents(cents);
  return negative && cents !== 0 ? -cents : cents;
}

/** Format cents for display: 123456 → "$1,234.56", -5 → "-$0.05". */
export function formatMoney(cents: Cents): string {
  assertCents(cents);
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const remainder = String(abs % 100).padStart(2, '0');
  return `${cents < 0 ? '-' : ''}$${dollars}.${remainder}`;
}

/**
 * Split `total` across `weights` in proportion, using the largest-remainder
 * method. The parts always add up to exactly `total`: no cent is created or
 * lost. Ties go to the earliest index, so the result is deterministic.
 *
 * Used, for example, to spread a partial payment across an invoice's income
 * lines, or a percentage milestone across the lines of an estimate.
 */
export function allocateProportionally(total: Cents, weights: readonly number[]): Cents[] {
  assertCents(total, 'total');
  if (weights.length === 0) throw new MoneyError('allocation needs at least one weight');
  for (const weight of weights) {
    if (!Number.isSafeInteger(weight) || weight < 0) {
      throw new MoneyError(`allocation weights must be non-negative integers, got ${weight}`);
    }
  }
  const weightSum = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  if (weightSum === 0n) throw new MoneyError('allocation weights must not all be zero');

  const sign = total < 0 ? -1n : 1n;
  const absTotal = BigInt(Math.abs(total));
  const shares = weights.map((weight, index) => {
    const exact = absTotal * BigInt(weight);
    return { index, base: exact / weightSum, remainder: exact % weightSum };
  });
  let leftover = absTotal - shares.reduce((sum, share) => sum + share.base, 0n);
  const byRemainder = [...shares].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const share of byRemainder) {
    if (leftover === 0n) break;
    share.base += 1n;
    leftover -= 1n;
  }
  return shares.map((share) => Number(share.base * sign));
}
