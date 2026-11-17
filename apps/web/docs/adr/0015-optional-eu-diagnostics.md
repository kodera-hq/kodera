# ADR-0015: Optional diagnostics use a consent-gated EU capture endpoint

Status: Accepted

## Context

Reliability and adoption measurements need a destination without sending workspace content or
account identifiers. ADR-0003 governs business operations; this decision supersedes it only for
the optional telemetry capture endpoint explicitly authorized by the product specification.

## Decision

A minimal, dependency-free adapter may POST allowlisted anonymous events to exactly
`https://eu.i.posthog.com/i/v0/e/`. Build configuration and explicit consent by the current
person for the current workspace in this browser are both required. All other hosts fail closed.
No SDK, replay, autocapture, DOM inspection, person profiles, persistent diagnostic identity,
URL enrichment or offline queue is installed. Requests omit cookies and referrers and refuse
redirects. Business operations continue using their existing backend boundaries.

The static server admits only this endpoint through an explicit deployment flag. The sole
native fetch exception is `src/analytics/telemetry/transport.ts`; no feature receives an exception.

## Consequences

Withdrawal synchronously unsubscribes the sink, aborts pending requests and wipes the local
session identifier. It cannot recall events already delivered. Operators remain responsible for
retention, access and erasure policies at the destination. IP addresses necessarily reach the
network endpoint; geo-IP enrichment is disabled. EU endpoint selection is not a claim that
network metadata is anonymous or that every downstream legal obligation is satisfied.

The [specification](../specs/privacy-first-telemetry.md) defines payload construction and tests.

The [capture API reference](https://posthog.com/docs/api/capture) defines the event envelope;
[anonymous event guidance](https://posthog.com/docs/data/anonymous-vs-identified-events) defines
the random visit identifier and disabled person-profile processing.
