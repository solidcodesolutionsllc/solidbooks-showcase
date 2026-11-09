# Money as integer cents

An accounting system has to be exact. This sample is the foundation SolidBooks
builds on: every amount is an integer number of cents, from the input field to
the database column.

| Function                     | What it guarantees                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `parseMoney`                 | Accepts what people type and what bank exports contain (`$1,234.56`, `(12.34)`), rejects anything ambiguous rather than rounding it |
| `multiplyQuantity`           | Hours × rate with three-decimal quantities, rounded half away from zero, computed in `bigint` so it never overflows                 |
| `allocateProportionally`     | Splits an amount across weights with the largest-remainder method; the parts always sum to the total                                |
| `addCents` / `subtractCents` | Refuse fractional cents and results outside the safe-integer range                                                                  |

## Design decisions

- **Integers, not decimals or floats.** `0.1 + 0.2 !== 0.3`. Cents keep every
  calculation exact and every comparison trivial, and they map directly to a
  PostgreSQL `bigint` column.
- **Fail loudly.** A value with three decimals is an input error, not something
  to round silently. Every function asserts its inputs and its result.
- **Deterministic allocation.** When a partial payment is spread across invoice
  lines, the same input must always produce the same split, so ties are broken
  by position. The property test checks that no cent is ever created or lost.

```sh
pnpm vitest run samples/money
```
