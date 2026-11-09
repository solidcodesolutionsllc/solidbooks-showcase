# Verifying signed webhooks

Payment processors and bank-data providers tell SolidBooks about payments,
refunds, disputes and new bank transactions through webhooks: HTTPS requests
from the public internet. Until its signature is verified, a webhook is just
untrusted input.

This sample is an original, dependency-free implementation of the
timestamped HMAC-SHA256 scheme used by common payment providers. In
production, SolidBooks delegates verification to each provider's official
library (and uses the provider's public-key scheme where it offers one); the
principles demonstrated here are the ones it relies on.

| Principle                                    | Why                                                           |
| -------------------------------------------- | ------------------------------------------------------------- |
| Verify the raw request bytes                 | Parsed and re-serialized JSON is not what was signed          |
| Constant-time comparison (`timingSafeEqual`) | Timing must not reveal how much of a forged signature matched |
| Timestamp tolerance (5 minutes)              | A captured request cannot be replayed later                   |
| Several accepted secrets                     | Secrets rotate without dropping events                        |
| Typed rejection reasons, body never logged   | Diagnosable without leaking payment data                      |

## What happens after verification (production)

- The event is stored once, keyed by the provider's event id, so a redelivered
  event is recognized and never applied twice
  ([`../idempotency`](../idempotency)).
- Amounts are re-fetched from the provider's API rather than trusted from the
  event body before anything is posted to the ledger.
- Events for the wrong mode (test vs. live) or for another account are refused.

Test secrets are generated randomly on each run; the repository contains no
secret-like strings.

```sh
pnpm vitest run samples/webhook-verification
```
