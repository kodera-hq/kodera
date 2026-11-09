# ADR-0010: Owner-claim consume has one enforced native dispatch boundary

**Status:** Accepted as a delegated technical decision; effective only after actual configured enforcement and source-bound acceptance pass, before any native client implementation is admitted
**Deciders:** Product owner delegates the implementation decision to the Lead/CTO

## Context

ADR-0005 routes mutations through `src/api/mutations.ts`; the production lint configuration
also prohibits global fetch in the existing client. The generic generated caller and its
asynchronous middleware retain outbound arguments across awaits. A fetch hook beneath
that caller does not remove those outer roots or establish an atomic final-currentness
to actual-native-invocation boundary. An explicit scoped exception is necessary; aliasing
fetch, using globalThis, adding a second client or silently removing a ban is not one.

## Decision

Partially supersede ADR-0005 only for `consumeOwnerClaim`: one named operation in
`src/api/client.ts` may invoke native fetch directly, through a locally enforced single
private synchronous callsite. It derives only the configured Core consume endpoint,
uses generated request/result/header types, requires the original caller-owned live
tuple/current bearer, performs final currentness after materialization, and returns
response work without retaining immutable outbound arguments across awaits. It never
allocates a key, retries automatically, accepts a URL/verb/fetch implementation from its
caller, or mounts an invitation/auth/consent journey. All other mutations continue
through mutations.ts; every read/query and ADR-0003/0007 boundary remains unchanged.
The exception is effective only with the actual configured lint restriction and
source-bound application acceptance; removal or bypass of enforcement refuses admission.

The native callsite is a nonoptional bare global fetch call immediately inside the
nonexported top-level synchronous nongenerator FunctionDeclaration
`invokeOwnerClaimNative`. The exact-client local `kodera/owner-claim-native-fetch` rule
replaces the old unconditional global ban only in `src/api/client.ts`, with error severity
and noInlineConfig. Other production files retain the original restriction. The rule
refuses the named alias/runtime-typeof/member/global-object/shadow/runtime-export escapes
and additional eligible source callsites. Type-only declarations/queries/exports do not
execute a request and are not runtime escape findings.

Zero callsites are legal while the policy is introduced; this package does not add native
client code. Later actual-client acceptance must require exactly one. The rule proves
reference placement, not a whole-function AST fingerprint, exhaustive JavaScript sandbox,
endpoint safety, currentness, identity, reference retirement or backend authority.

## Effective gates

The actual configured public-ESLint acceptance must pass its current-source positive,
allowed private-callsite positive, erased-only positive, eleven exact refusal inputs
with fresh restorations, and separate disabled-guard health refusal/recovery. Existing
required CI remains mandatory; a toy visitor or parser/setup/ignored-file failure is
not enforcement proof. No native operation is admitted merely by accepting this ADR.

Before application code is admitted, source-bound acceptance must additionally qualify
configured Core origin/prefix/fixed consume POST, generated omission/null/empty/value
semantics, explicit original key/body/current bearer, final guard immediately before
actual native invocation, nonthenable response work and retiring async roots. Existing
ApiProblem/NetworkError handling, no secret logging, no automatic resend and lock release
before a pending response remain mandatory. Aborting does not prove backend noncommit.

## Consequences and limits

This permits one previously forbidden source boundary explicitly, rather than claiming
the old unconditional ban is unchanged. Named escape checks strengthen the remaining
boundary without pretending lint alone proves transport security. The focused test
loads the real configuration through public ESLint APIs; fixtures remain in-memory
parsed text, not executable requests or an alternate production client.

Deliberate exact-tuple retry, retirement and deliberate original-invitation new-intent
recovery keep their accepted semantics. No keeper/popup UX, protected-auth journey,
coordinator, secret store, endpoint, provider, serving/operator readiness, global
invitation single-use rule or release is adopted. These remain independently gated.
ADR-0005's accepted text is preserved except its Status; only this operation is partially
superseded. ADR-0003/0007 and ordinary mutation/query rules continue unchanged.
