# Double-entry validation

Every invoice, payment, fee, transfer and correction in SolidBooks becomes a
journal entry whose debits equal its credits. This sample is the
application-side check that runs before an entry reaches the database.

## What it shows

- **Type-safe domain modeling.** Entries and lines are immutable (`readonly`)
  value types; problems are a closed union of codes (`JournalIssueCode`) that
  the API maps to user-facing messages.
- **Report everything, not just the first error.** The editor can highlight
  every faulty line at once because validation collects all issues, each with
  its line index.
- **Corrections by reversal.** `reverseLines` builds the mirror image of an
  entry. A posted entry is never edited; it is reversed and, if needed,
  replaced. The audit trail keeps both.
- **Defense in depth.** The same rules are enforced again by PostgreSQL
  triggers ([`../immutable-ledger`](../immutable-ledger)). This module gives
  precise error messages; the database guarantees integrity even if an
  application bug slipped past it.

```sh
pnpm vitest run samples/double-entry
```
