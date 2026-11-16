# ADR-0014: Durable confidential-device requests have one closed native dispatcher

Status: Proposed; effective only after configured enforcement and source-bound acceptance.
Deciders: Lead/CTO under the existing delegated client implementation scope.

## Context

ADR-0005 routes ordinary reads through the query cache and mutations through mutations.ts.
ADR-0010 permits one precisely enforced native dispatch only for consumeOwnerClaim. A durable
confidential-device request must send exactly the body and logical key persisted before transport;
generic asynchronous middleware may otherwise retain/recreate arguments or choose another key.
Initial explicit create/restore and each prepared POST attempt also need their own one-use principal observation from the same fixed new network `/me` read,
not reuse the same-credential UI cache. A public response DTO, structural type or callback is not
proof that Core accepted a device. The specification is
[`device-http.spec.md`](../../src/features/confidential/device-http.spec.md).

## Decision

If accepted, narrowly extend the raw-fetch exception of ADR-0005/0010 for exactly one additional
private synchronous nongenerator top-level FunctionDeclaration in src/api/client.ts, provisionally
named invokeConfidentialDeviceNative. The existing invokeOwnerClaimNative boundary and every
accepted refusal/health control remain unchanged. Actual configured enforcement admits exactly
those two private source callsites when both features are implemented; it does not permit a generic
native transport, exported callsite, fetch alias/member/global-object access, injected fetch or
additional occurrence. No other production file gains native fetch permission.

The new callsite handles only these fixed operation/method/path pairs under the validated configured
Core API origin and version prefix:

| Closed operation | Method | Relative path |
| --- | --- | --- |
| One-use observation for captured explicit device initialization or one prepared POST attempt | GET | /me |
| Register this native device | POST | /organisations/{organisation_id}/confidential/devices |
| Publish its one retained native key package | POST | /organisations/{organisation_id}/confidential/key-packages |

No caller supplies a URL, verb, transport, credential provider or arbitrary headers. Organisation
UUIDs come from the accepted private context. Requests retain the original durable UUID key and
body bytes, set fixed content type and the exact current ephemeral bearer, refuse redirects and
apply bounded response/time controls. No automatic resend/key allocation is introduced. A private
one-use attempt cell is consumed after final currentness/worker/RPC checks immediately before actual
native invocation; no await or user callback intervenes. It returns privately owned response work
with retirement of outbound roots, not a generic fetch capability.

The application owner is the real `/me`.id Core person UUID. The current SDK issuer/subject must
match one current Core identity and its unique active organisation membership, whose identity_id is
required and must match. A private dispatcher owns the same fixed GET for one captured explicit create/restore intent
or one prepared POST attempt. The initialization result is bound to that intent, resolved scope and
Worker/RPC; it cannot be reused as a POST observation or portable authority. It keeps bearer custody on the existing AuthAdapter/client side and communicates with the
exclusive device worker through a private fixed port. Only the actual dispatch response cell can
originate a correlated 201 outcome; there is no public accept-result method. The worker keeps its
native provider, wrapping seed and real storage handle private. This does not add a Core ticket,
server revision, identity lookup endpoint or remotely verified human identity.

This partially supersedes only the ordinary cached-read/mutation transport clauses for these three
closed paths and the old statement that consumeOwnerClaim is the sole native exception. All other
reads, mutations, routing, query state, owner-claim semantics and ADR-0003/0007 token/backend boundaries
remain in force. Accepted ADR-0013's shared-community rules remain unchanged. Existing ADR files
are not otherwise rewritten. While this record is Proposed, no production exception is effective.

## Effective gates

The real configured public ESLint policy must preserve owner-claim's source positive, exact eleven
refusals, type-erasure controls and disabled-guard health checks. Add actual allowed private
confidential callsite and closed operation/path positives plus aliases, exported/nested/async
callsite, multiplicity, arbitrary origin/path/verb/fetch, shadow/global-object and disabled-guard
negatives. Never turn off the rule, add a directory-wide exception or substitute a toy parser.

Qualify actual compiled worker/strict IndexedDB CAS, dual native/host generations, exact 276-byte
KDA2, bounded KDH1 and one-shot recoverySpent behavior. Test the genuine fixed Core/PG HTTP route
under a separately opted-in synthetic test deployment, including registration/publication lost ACK,
worker restart, identical key/body retry, principal/worker/RPC retirement and fake outcome refusal.
Require fresh observation and exact final-currentness to actual invocation/response-publication
controls; no lint result alone proves endpoint or authority correctness. Aborting does not prove
backend noncommit. Current Core effect authorization remains authoritative after any local read.

No workflow, dependency or operator gate is changed by this record. Full existing native/Web/CI
and the new source-bound acceptance remain required before implementation acceptance.

## Options considered

- Generic generated POST middleware: retains object/key adaptation across asynchronous work and
  cannot by itself establish this exact persisted-byte dispatch boundary.
- Cached UI `/me`: does not provide the required fresh per-attempt observation.
- Worker-owned bearer/network: a possible later architecture, but adds credential transfer and
  worker authentication custody; unnecessary for this first closed dispatcher.
- Caller-provided 201/fetch/currentness interfaces: rejected because structural shape can substitute
  for the actual authority/transport source.

## Consequences

One additional native source boundary becomes inspectable and enforced without broad network
permission. Its runtime decoder, local context fence, private port and exact pending operation are
still trusted code and need independent review. Same-origin compromise, rollback of all persisted
fences, hardware protection, multi-client group coordination, participant verification, media and
production enablement remain outside this device-admission increment. Ordinary browser/tenant
transport ADRs and current default-off confidential relay policy are preserved.
