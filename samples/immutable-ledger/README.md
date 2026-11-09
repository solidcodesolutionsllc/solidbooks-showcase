# Immutable ledger, enforced by the database

Application code validates every journal entry first
([`../double-entry`](../double-entry)). PostgreSQL then enforces the same
rules on its own, so no code path, script or future bug can commit an
unbalanced entry or quietly rewrite history.

| Invariant                                                               | How it is enforced                                          | SQLSTATE |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- | -------- |
| Debits equal credits, at least two lines                                | Deferred constraint trigger, checked at `COMMIT`            | `SB001`  |
| Lines belong to the transaction that created the entry                  | `BEFORE INSERT` trigger comparing `txid_current()`          | `SB006`  |
| Posted lines are never updated, deleted or truncated                    | `BEFORE UPDATE/DELETE/TRUNCATE` triggers                    | `SB002`  |
| An entry changes only to be marked reversed, once, by its real reversal | `BEFORE UPDATE` guard plus `CHECK` and `UNIQUE` constraints | `SB002`  |

## Design decisions

- **Deferred balance check.** A business command can insert an entry and its
  lines in any order; the database checks the result once, at commit. A failed
  command leaves nothing behind.
- **Sealed entries.** Appending a _balanced_ pair of lines to last month's
  entry would pass a balance check while changing history. Tying lines to the
  creating transaction closes that gap.
- **Corrections are reversals.** Mistakes are fixed by posting the mirror
  image and, if needed, a corrected entry. Reports stay reproducible and the
  audit trail is complete.
- **Precise errors.** Custom SQLSTATE codes let the API turn each violation
  into a specific, actionable message instead of a generic 500.

The production schema adds lock dates (closed periods), archived accounts,
cash-basis lines and an append-only audit log, enforced the same way. This
sample keeps only the core.

The tests run against real PostgreSQL compiled to WebAssembly
([PGlite](https://pglite.dev)), in memory:

```sh
pnpm vitest run samples/immutable-ledger
```
