# ADR-0022: Payment link creation asks the provider from the API, outside the replay step

**Status:** Proposed
**Owner:** API seat
**Deciders:** Integration lead under the delegated technical mandate; independent backend and
security review remains a merge gate.

## Context

ADR-0004 and `docs/domain/JOB_CATALOGUE.md` route commercial effects, payment requests among them,
through the outbox and the worker. `docs/specs/IDEMPOTENCY_REPLAY.md` §3 forbids a replay-store
handler from calling the outside world. ADR-0020 asks every effect-bearing operation for a durable
operation identity.

`createPaymentLink` cannot follow the outbox path: the contract answers `201` with the provider's
checkout URL, which the payer opens at once, and `502 upstream-unavailable` when the provider does
not answer. A worker delivery has no response to put the URL in. `SETTINGS_AND_SECRETS.md` §2
already gives the API a restricted key limited to creating and expiring Checkout Sessions.

## Decision

- **The API asks the provider synchronously, before the replay store's step and outside any
  transaction.** This is an exception to ADR-0004 and JOB_CATALOGUE.md for this one operation. It
  checks first, without a lock, that the store holds no live answer under the request's key, so a
  replay or a reuse of an answer the store already holds never reaches the provider. A same-key
  retry sent while the first request is still running may make one provider call, which is
  withdrawn when the store answers `idempotency-key-in-flight`.
- **The step only records.** It runs under the invoice's row lock and records the issued link as
  the invoice's one active link, or returns the active link another press recorded first.
- **Withdrawal compensates.** An issued link that the step does not keep as active is withdrawn at
  the provider: the step refused, it rolled back, or the store refused the key. A link the step
  records `cancelled` is withdrawn after commit, and `withdraw_cancelled_links` retries a refusal.
  An issued link recorded nowhere is withdrawn once, and a failed withdrawal is logged.
- **The durable identity is the invoice's single active link.** At most one link per invoice is
  `active`, held under the invoice's lock. This takes the place of ADR-0020's operation identity
  for this operation. An orphaned provider session left by a crash between issue and record was
  never handed to anyone, and it expires at the provider.
- **No other route calls a provider from the API on this basis.** A new one needs its own record.

## Consequences

- A press can create a provider session that is withdrawn moments later, for example when two
  first presses race. This costs a provider call and is not an effect on the customer.
- A retry under the same key, once the first answer is stored, never asks the provider again. A
  new key, or the same key after its 24-hour receipt expired, asks again only when the invoice has
  no active link.
- The API also calls the provider after a commit, to withdraw links: those `createPaymentLink`
  issued and did not keep, and the active links of an order `cancelOrder` cancels. Each call is
  bounded by the provider adapter's timeout. With no provider configured, the withdrawal is logged
  as a warning, and `withdraw_cancelled_links` on the operator retries every cancelled link.
- The provider's own idempotency key is not yet derived from the client key. That is follow-up
  work under ADR-0020.
