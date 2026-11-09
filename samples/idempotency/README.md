# Exactly-once commands with an Idempotency-Key

A client that times out cannot know whether the server recorded the payment.
It retries, and a financial system must not record it twice. Every create
request in SolidBooks (invoices, payments, credit memos, refunds, ...) carries
an `Idempotency-Key`, and `withIdempotency` runs the command at most once per
key.

| Situation                            | Outcome                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| First request                        | Command runs; response stored with the key                |
| Retry, same key and request          | Stored response replayed (`replayed: true`); nothing runs |
| Same key, different request          | `422`: refused rather than silently replayed              |
| Command fails                        | Nothing stored; the same key can be retried               |
| Concurrent duplicates (double click) | One runs; the others wait on the key row, then replay     |

## Design decisions

- **Claim and command share one transaction.** The key is only stored if the
  command commits, so a crash or validation error never "burns" a key, and a
  committed command always has its response recorded.
- **The database does the locking.** `INSERT ... ON CONFLICT DO NOTHING` on the
  primary key makes a concurrent duplicate wait for the first transaction
  instead of racing it. No in-memory locks, so it holds across server instances.
- **Fingerprinting.** The key is bound to a hash of the method, route and body,
  which catches client bugs that reuse keys.
- **Bounded storage.** Keys expire after 24 hours.

The same principle protects inbound events: payment webhooks are stored by the
provider's event id, so a redelivered event is recognized and never applied
twice.

```sh
pnpm vitest run samples/idempotency
```

The tests use in-memory PGlite, which runs one transaction at a time, so the
concurrency test exercises the serialized path. On a PostgreSQL server the
primary-key lock gives the same outcome for truly parallel requests.
