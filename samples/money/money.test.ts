import { describe, expect, it } from 'vitest';
import {
  addCents,
  allocateProportionally,
  formatMoney,
  MoneyError,
  multiplyQuantity,
  parseMoney,
  subtractCents,
} from './money.js';

describe('parseMoney', () => {
  it.each([
    ['1234.56', 123456],
    ['$1,234.56', 123456],
    ['2500', 250000],
    ['0.5', 50],
    ['-12.34', -1234],
    ['(12.34)', -1234],
    ['  $0.01 ', 1],
    ['0', 0],
    ['-0', 0],
  ])('parses %j as %d cents', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });

  it.each(['', 'abc', '1.234', '1,23.4.5', '$-', '12.3.4', '1e3'])('rejects %j', (input) => {
    expect(() => parseMoney(input)).toThrow(MoneyError);
  });
});

describe('formatMoney', () => {
  it('formats with thousands separators and a leading sign', () => {
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(-5)).toBe('-$0.05');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('round-trips with parseMoney', () => {
    for (const cents of [1, 99, 100, 123456, -98765, 1_000_000_00]) {
      expect(parseMoney(formatMoney(cents))).toBe(cents);
    }
  });
});

describe('integer arithmetic', () => {
  it('is exact where floating-point dollars drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addCents(10, 20)).toBe(30);
    expect(subtractCents(100000, 33333)).toBe(66667);
  });

  it('refuses fractional cents and unsafe results', () => {
    expect(() => addCents(1.5)).toThrow(MoneyError);
    expect(() => addCents(Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError);
  });
});

describe('multiplyQuantity (hourly billing)', () => {
  it('multiplies hours by rate and rounds half away from zero', () => {
    expect(multiplyQuantity(1500, 12500)).toBe(18750); // 1.5 h at $125.00
    expect(multiplyQuantity(333, 10000)).toBe(3330); // 0.333 h at $100.00
    expect(multiplyQuantity(1, 500)).toBe(1); // 0.5¢ rounds up to 1¢
    expect(multiplyQuantity(-1, 500)).toBe(-1); // and symmetrically down
  });

  it('computes large intermediates without overflow', () => {
    expect(multiplyQuantity(1_000_000_000, 10_000_000)).toBe(10_000_000_000_000);
  });
});

describe('allocateProportionally', () => {
  it('always adds up to the total', () => {
    expect(allocateProportionally(100000, [70000, 30000])).toEqual([70000, 30000]);
    const thirds = allocateProportionally(100, [1, 1, 1]);
    expect(thirds).toEqual([34, 33, 33]);
    expect(addCents(...thirds)).toBe(100);
  });

  it('spreads a partial payment across invoice lines', () => {
    // $333.33 received against an invoice with $700.00 and $300.00 lines.
    expect(allocateProportionally(33333, [70000, 30000])).toEqual([23333, 10000]);
  });

  it('treats negative totals symmetrically', () => {
    expect(allocateProportionally(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });

  it('never loses a cent, whatever the weights', () => {
    for (let total = -500; total <= 500; total += 37) {
      for (const weights of [[1], [3, 7], [1, 1, 1, 1, 1, 1, 1], [0, 5, 0, 9]]) {
        expect(addCents(...allocateProportionally(total, weights))).toBe(total);
      }
    }
  });

  it('rejects weights it cannot use', () => {
    expect(() => allocateProportionally(100, [])).toThrow(MoneyError);
    expect(() => allocateProportionally(100, [0, 0])).toThrow(MoneyError);
    expect(() => allocateProportionally(100, [-1, 2])).toThrow(MoneyError);
  });
});
