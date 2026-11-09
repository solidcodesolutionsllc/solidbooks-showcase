# Invoice domain modeling with TypeScript and Zod

Invoices look simple until the edge cases arrive: discount lines, fractional
hours, payment terms across a year end, leap days, a schedule that bills on the
31st, an invoice that is both partly paid and overdue.

## What it shows

- **One source of truth for input.** `InvoiceDraftSchema` validates untrusted
  input at the API boundary and _is_ the TypeScript type behind it
  (`z.output<typeof InvoiceDraftSchema>`). Errors come back per field, ready
  for the form to display.
- **Server-side pricing.** `computeTotals` recomputes every line from quantity
  and rate in integer cents ([`../money`](../money)); totals sent by a client
  are never trusted.
- **Derived, never stored.** "Paid", "partial" and "overdue" are computed from
  the live balance and today's date, so they can't go stale.
- **Calendar dates, not instants.** Due dates and billing dates are pure
  date arithmetic in UTC: time zones and daylight-saving changes cannot move
  them.
- **Recurring edge cases.** A schedule on the 31st bills Jan 31, Feb 28 and
  Mar 31 (no drift to the 28th), and each run is keyed by the period it bills,
  so a period is billed at most once however often the scheduled job runs.
- **Pure functions.** No I/O and no hidden clock: every rule is deterministic
  and directly testable.

```sh
pnpm vitest run samples/domain-modeling
```
