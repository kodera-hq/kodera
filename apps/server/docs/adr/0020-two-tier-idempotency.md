# ADR-0020: Response replay and durable effect identity are separate tiers

**Status:** Accepted
**Owner:** API seat
**Deciders:** Integration lead under the delegated technical mandate; independent backend and
security review remains a merge gate.

## Context

Core's shared replay store scopes a key to verified issuer, subject, method and path, fingerprints
request bytes, and retains a response for 24 hours. Once that receipt expires, the current store
deletes it and executes the handler again. That is safe only when the handler has its own durable
identity for every effect.

Jobs and orders already demonstrate the second tier: they keep lifetime-unique job keys or an
organisation-scoped order key and a semantic request hash. The first-slice operation contract must
make that property universal for effect-bearing operations without turning the response cache into
a workflow engine.

## Decision

- The HTTP response receipt remains a 24-hour replay convenience. It may store an admitted response
  and expire independently of the effect record.
- Every effect-bearing operation also has a durable operation identity composed from the verified
  principal, authorization organisation, stable operation kind, target identity or explicit
  creation scope, and client intention key. The encoding is structured, not concatenated text.
- Its fingerprint covers the validated semantic request, including accepted legal versions, price
  references and effect-bearing preconditions. JSON object order and insignificant whitespace do
  not change it. Duplicate keys, unsupported fields and ambiguous input are rejected before it is
  recorded.
- A same identity and same fingerprint resolves to the existing operation. A different fingerprint
  conflicts. A different target or operation kind may legitimately reuse the client key.
- Expiry or purge of the response receipt never permits a second effect. The durable domain record
  returns or redrives the existing result, or answers with an explicit expired-operation refusal
  when a result can no longer be represented.
- Authorization is evaluated from current state before any stored result is released. One-time
  tokens, secrets and expiring download URLs are not replayed as authority.
- A Job, Order or other domain record may be the durable operation record. A generic duplicate
  workflow table is not required where the domain record holds the complete identity, fingerprint
  and result reference.
- Durable operation identity remains at least as long as the effect can be retried, reconciled or
  mistaken for a new effect. A longer record-class retention policy still governs where applicable.

## Options considered

| Option | Decision |
|---|---|
| Treat the 24-hour receipt as complete idempotency | Rejected. A retry after expiry can repeat an external or commercial effect. |
| Retain every response forever | Rejected. Response bytes can contain stale representations and are not the effect's authority. |
| Short receipt plus durable domain identity | Chosen. It separates HTTP convenience from effect safety and reuses existing records. |

## Consequences

- The generic replay store remains a tier-one component; its present expiry behavior is not itself
  a product defect when a route's tier-two record prevents a repeated effect.
- Routes without a durable effect identity may not dispatch an external or commercial effect.
- The current raw-byte fingerprint remains an implementation gap for semantic operation identity;
  it is not silently redefined by this documentation-only change.
- `FS-OP-05` is no longer blocked on a decision. It remains expected red at the earlier real-provider
  second-factor gap, and later must prove one effect after response-receipt expiry.

## Changelog

- First version. Separates the short HTTP response receipt from durable semantic identity for an
  effect-bearing operation.
