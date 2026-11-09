# ADR-0009: The Console has agreed Kodera deployment origins

**Status:** Accepted
**Deciders:** zôÖma

## Context

ADR-0001 established the Console as a separate application and named
`app.kodera.io` as its deployment address. The owner-relayed operator facts
identify two agreed Console origins, without a nonroot deployment prefix.
The address selection needs to be superseded while its history and the
separate-application decision are preserved.

## Decision

The agreed staging origin is `https://app.staging.kodera.io` and the agreed
production origin is `https://app.kodera.io`. Both serve at the origin root;
no nonroot deployment prefix is defined by this decision.

This record supersedes only ADR-0001's deployment-address selection.
ADR-0001 remains accepted in every other respect, subject to the later
accepted records that already govern those decisions. The Console remains
a separate application, repository and deployment. No hub, token,
authentication, provider, hosting architecture or backend boundary changes.

These are deployment targets, not evidence of a deployed Console. This
record does not establish DNS or HTTP availability, register a redirect,
select an issuer, configure a realm, or authorize deployment or purchase.

## Options considered

- Keep the legacy address as the current target: rejected because it no
  longer reflects the agreed origins.
- Replace the accepted ADR's historical address in place: rejected by the
  repository's immutable accepted-record policy.
- Record only this address supersession: selected; preserve the prior
  architecture and the operator's separate execution responsibilities.

## Consequences

Documentation may refer to these agreed targets under this accepted record.
Runtime callbacks, payment returns, generated contracts and deployment
configuration require their own accepted scope and verification. No current
runtime constant, response, allowlist or environment value changes here.
In particular, the executable payment return URLs remain separate work.
